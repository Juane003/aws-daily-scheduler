import { retryDelayS, type Random } from '../../common/backoff.js';
import { deferDelayS } from '../../common/circuit-breaker.js';
import type { Config } from '../../common/config.js';
import {
  classifyError,
  classifyResponse,
  type Classification,
} from '../../common/error-classifier.js';
import {
  nextMessage,
  parseJobMessage,
  toDeadLetterMessage,
  type DeadLetter,
  type DeadLetterReason,
  type JobMessage,
} from '../../common/message.js';
import type { LogFields, Logger, Metrics } from '../../common/telemetry.js';
import { endOfBusinessDay } from '../../common/time.js';
import type { Execution, ExecutionKey } from '../model.js';
import type {
  ApiResponse,
  CircuitRepository,
  Clock,
  ExecutionCondition,
  ExecutionPatch,
  ExecutionRepository,
  FifoQueue,
  InternalApi,
  ObjectStore,
  RegistryRepository,
  StandardQueue,
} from '../ports.js';
import { ProviderCircuits } from './circuit.js';

/**
 * Worker (CLAUDE.md §6.2). Handles one FIFO message: deadline, breaker, claim, call, and one of the
 * result branches. Returning means "ACK"; throwing means "let the FIFO redeliver".
 *
 * Critical rule: before returning, the job is already in `retry` or the DLQ when it needs to be.
 * - Terminal branches send to the DLQ **before** writing the terminal status: if the status were
 *   written first and the send failed, the redelivery would see a terminal row and ACK, and the
 *   dead letter would be lost.
 * - Retry branches write `RETRYING` **before** sending to `retry`: if the send fails, the
 *   redelivery can claim the `RETRYING` row and try again.
 */

export type WorkerOutcome =
  | 'SUCCEEDED'
  | 'RETRY_SCHEDULED'
  | 'DEFERRED'
  | 'FAILED_NON_RETRYABLE'
  | 'FAILED_EXHAUSTED'
  | 'FAILED_EXPIRED'
  | 'INVALID_MESSAGE'
  /** The claim (or the defer) found nothing to do: a duplicate, or the job already finished. */
  | 'DUPLICATE'
  /** The claim was taken over (stale) while this Worker was calling; its result is discarded. */
  | 'CLAIM_LOST';

export interface WorkerDeps {
  repository: RegistryRepository & ExecutionRepository & CircuitRepository;
  api: InternalApi;
  retryQueue: StandardQueue;
  deadLetterQueue: FifoQueue;
  objectStore: ObjectStore;
  clock: Clock;
  logger: Logger;
  metrics: Metrics;
  config: Config;
  random?: Random;
}

const PENDING: Execution['status'][] = ['ENQUEUED', 'RETRYING'];

export class Worker {
  private readonly circuits: ProviderCircuits;
  private readonly random: Random;

  constructor(private readonly deps: WorkerDeps) {
    this.circuits = new ProviderCircuits(deps);
    this.random = deps.random ?? Math.random;
  }

  async handle(body: string): Promise<WorkerOutcome> {
    const { clock, config, logger } = this.deps;
    const parsed = parseJobMessage(body);
    if (!parsed.ok) {
      await this.deadLetter({ reason: 'INVALID_MESSAGE', error: parsed.error, raw: body });
      logger.log('error', 'invalid message sent to DLQ', { error: parsed.error });
      this.deps.metrics.count('JobsFailed', { reason: 'INVALID_MESSAGE' });
      return 'INVALID_MESSAGE';
    }
    const message = parsed.message;
    const key: ExecutionKey = { registryId: message.registryId, runDate: message.runDate };

    // Deadline: a job that could not finish within its day plus the grace period is abandoned.
    const deadline = endOfBusinessDay(message.runDate, config.businessTz).getTime();
    if (clock.now().getTime() > deadline + config.expiryGraceH * 3_600_000) {
      return this.expire(message, key);
    }

    // Breaker: owner = jobId, so a redelivery of the probe job keeps the probe.
    const admission = await this.circuits.allow(message.providerId, message.jobId);
    if (admission.kind === 'DEFER') return this.defer(message, key, admission.until);
    const probe = admission.kind === 'PROBE';

    const claimed = await this.deps.repository.claimExecution(key, clock.now(), config.staleAfterS);
    if (claimed === undefined) {
      logger.log('info', 'claim found nothing to do', fields(message));
      return 'DUPLICATE';
    }
    return this.execute(message, key, claimed, probe);
  }

  private async execute(
    message: JobMessage,
    key: ExecutionKey,
    claimed: Execution,
    probe: boolean,
  ): Promise<WorkerOutcome> {
    const { repository, api, clock, config, metrics, logger } = this.deps;
    // The claim's started_at fences every later write: a stale takeover invalidates them.
    const owned: ExecutionCondition = {
      status: ['IN_PROGRESS'],
      ...(claimed.startedAt === null ? {} : { startedAt: claimed.startedAt }),
    };
    const attempt = claimed.attempt;
    const ctx = { ...fields(message), attempt, probe };

    const registry = await repository.getRegistry(message.registryId);
    if (registry?.enabled !== true) {
      const errorType = registry === undefined ? 'REGISTRY_NOT_FOUND' : 'REGISTRY_DISABLED';
      return this.fail(message, key, owned, 'NON_RETRYABLE', { errorType, httpStatus: null });
    }

    const startedAt = clock.now();
    let response: ApiResponse | undefined;
    let classification: Classification;
    try {
      response = await api.call({
        method: registry.httpMethod,
        endpoint: registry.endpoint,
        body: registry.body,
        headers: { 'Idempotency-Key': message.jobId, 'X-Provider-Id': message.providerId },
        timeoutMs: config.httpTimeoutMs,
      });
      classification = classifyResponse(response, clock.now());
    } catch (error) {
      classification = classifyError(error);
      logger.log('warn', 'internal API call failed', { ...ctx, error });
    }
    const finishedAt = clock.now();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    metrics.record('DownstreamLatency', durationMs, { provider: message.providerId });
    const httpStatus = response?.status ?? null;

    switch (classification.kind) {
      case 'SUCCESS': {
        await this.circuits.recordSuccess(message.providerId, message.jobId);
        const stored = await this.storeResult(key, response, durationMs, finishedAt, owned);
        if (!stored) return this.claimLost(ctx);
        metrics.count('JobsSucceeded');
        logger.log('info', 'job succeeded', { ...ctx, httpStatus, durationMs });
        return 'SUCCEEDED';
      }

      case 'NON_RETRYABLE': {
        // Not a breaker failure. But a probe that got an HTTP answer proves the provider is up:
        // closing the circuit avoids leaving HALF_OPEN without an owner until it goes stale.
        if (probe) await this.circuits.recordSuccess(message.providerId, message.jobId);
        if (classification.credentialAlarm) {
          metrics.count('CredentialErrors', { provider: message.providerId });
          logger.log('error', 'credential error from internal API', { ...ctx, httpStatus });
        }
        return this.fail(message, key, owned, 'NON_RETRYABLE', {
          errorType: classification.errorType,
          httpStatus,
        });
      }

      case 'RETRYABLE': {
        await this.circuits.recordFailure(message.providerId, message.jobId);
        const failure = { errorType: classification.errorType, httpStatus };
        if (attempt >= config.maxAttempts) {
          return this.fail(message, key, owned, 'EXHAUSTED', failure);
        }
        const delayS = retryDelayS(attempt, classification.retryAfterS, config, this.random);
        const next = nextMessage(message, 'RETRY', attempt);
        const scheduled = await repository.updateExecution(key, owned, {
          status: 'RETRYING',
          seq: next.seq,
          nextAttemptAt: new Date(finishedAt.getTime() + delayS * 1000),
          lastHttpStatus: httpStatus,
          lastErrorType: failure.errorType,
          lastError: null,
        });
        if (!scheduled) return this.claimLost(ctx);
        await this.deps.retryQueue.send(JSON.stringify(next), delayS);
        metrics.count('RetryScheduled', { provider: message.providerId });
        logger.log('info', 'retry scheduled', { ...ctx, ...failure, delayS, seq: next.seq });
        return 'RETRY_SCHEDULED';
      }
    }
  }

  /** Breaker open: back to `retry` without calling and without consuming an attempt. */
  private async defer(message: JobMessage, key: ExecutionKey, until: Date): Promise<WorkerOutcome> {
    const { repository, clock, config, metrics, logger } = this.deps;
    const now = clock.now();
    const delayS = deferDelayS(until, now, config, this.random);
    const next = nextMessage(message, 'CIRCUIT_DEFER');
    const deferred = await repository.updateExecution(
      key,
      { status: PENDING },
      { status: 'RETRYING', seq: next.seq, nextAttemptAt: new Date(now.getTime() + delayS * 1000) },
    );
    if (!deferred) {
      logger.log('info', 'defer found nothing to do', fields(message));
      return 'DUPLICATE';
    }
    await this.deps.retryQueue.send(JSON.stringify(next), delayS);
    metrics.count('JobsDeferred', { provider: message.providerId });
    logger.log('info', 'job deferred by open circuit', { ...fields(next), delayS });
    return 'DEFERRED';
  }

  private async expire(message: JobMessage, key: ExecutionKey): Promise<WorkerOutcome> {
    const row = await this.deps.repository.getExecution(key);
    if (row !== undefined && !['ENQUEUED', 'RETRYING', 'IN_PROGRESS'].includes(row.status)) {
      return 'DUPLICATE';
    }
    return this.fail(message, key, { status: ['ENQUEUED', 'RETRYING', 'IN_PROGRESS'] }, 'EXPIRED', {
      errorType: 'EXPIRED',
      httpStatus: null,
    });
  }

  /** DLQ first, then the terminal status (see the class comment). */
  private async fail(
    message: JobMessage,
    key: ExecutionKey,
    condition: ExecutionCondition,
    reason: Exclude<DeadLetterReason, 'INVALID_MESSAGE'>,
    failure: { errorType: string; httpStatus: number | null },
  ): Promise<WorkerOutcome> {
    const { repository, clock, metrics, logger } = this.deps;
    await this.deadLetter({ reason, error: failure.errorType, message });
    const status = TERMINAL_BY_REASON[reason];
    const patch: ExecutionPatch = {
      status,
      finishedAt: clock.now(),
      nextAttemptAt: null,
      lastErrorType: failure.errorType,
    };
    if (failure.httpStatus !== null) patch.lastHttpStatus = failure.httpStatus;
    const updated = await repository.updateExecution(key, condition, patch);
    metrics.count('JobsFailed', { reason });
    logger.log(
      updated ? 'warn' : 'error',
      updated ? 'job failed' : 'job failed, status not updated',
      {
        ...fields(message),
        reason,
        ...failure,
      },
    );
    return status;
  }

  private async storeResult(
    key: ExecutionKey,
    response: ApiResponse | undefined,
    durationMs: number,
    createdAt: Date,
    condition: ExecutionCondition,
  ): Promise<boolean> {
    const body = response?.body ?? '';
    const inline = Buffer.byteLength(body, 'utf8') <= this.deps.config.resultInlineMaxBytes;
    let responseS3Key: string | null = null;
    if (!inline) {
      responseS3Key = `results/${key.runDate}/${key.registryId}.json`;
      await this.deps.objectStore.put(responseS3Key, body);
    }
    return this.deps.repository.succeedExecution(key, condition, {
      ...key,
      httpStatus: response?.status ?? 200,
      durationMs,
      response: inline ? parseBody(body) : null,
      responseS3Key,
      createdAt,
    });
  }

  private claimLost(ctx: LogFields): WorkerOutcome {
    this.deps.logger.log('warn', 'claim lost before writing the result', ctx);
    return 'CLAIM_LOST';
  }

  private async deadLetter(letter: Omit<DeadLetter, 'failedAt'>): Promise<void> {
    const full: DeadLetter = { ...letter, failedAt: this.deps.clock.now().toISOString() };
    await this.deps.deadLetterQueue.send(
      toDeadLetterMessage(full, this.deps.config.providerShards),
    );
  }
}

const TERMINAL_BY_REASON = {
  NON_RETRYABLE: 'FAILED_NON_RETRYABLE',
  EXHAUSTED: 'FAILED_EXHAUSTED',
  EXPIRED: 'FAILED_EXPIRED',
} as const;

function fields(message: JobMessage): LogFields {
  return {
    jobId: message.jobId,
    providerId: message.providerId,
    runDate: message.runDate,
    attempt: message.attempt,
    seq: message.seq,
    reason: message.reason,
  };
}

/** `results.response` is JSONB: keep JSON as-is, wrap anything else as a JSON string. */
function parseBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}
