import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../../src/adapters/memory/clock.js';
import { InMemoryFifoQueue } from '../../src/adapters/memory/fifo-queue.js';
import { InMemoryLogger } from '../../src/adapters/memory/logger.js';
import { InMemoryMetrics } from '../../src/adapters/memory/metrics.js';
import { InMemoryObjectStore } from '../../src/adapters/memory/object-store.js';
import { InMemoryRepository } from '../../src/adapters/memory/repository.js';
import { InMemoryStandardQueue } from '../../src/adapters/memory/standard-queue.js';
import { initialCircuit, transition, type CircuitState } from '../../src/common/circuit-breaker.js';
import { defaults, type Config } from '../../src/common/config.js';
import {
  newJobMessage,
  parseJobMessage,
  type DeadLetter,
  type JobMessage,
} from '../../src/common/message.js';
import { Worker } from '../../src/core/execute/worker.js';
import type { ApiRequest, ApiResponse, InternalApi } from '../../src/core/ports.js';
import { createWorkerHandler } from '../../src/handlers/worker.js';

const t0 = new Date('2026-03-01T12:00:00Z');
const day = '2026-03-01';
const key = (registryId = '1') => ({ registryId, runDate: day });

class ScriptedApi implements InternalApi {
  readonly calls: ApiRequest[] = [];
  respond: (request: ApiRequest) => Promise<ApiResponse> = () => Promise.resolve(ok());

  call(request: ApiRequest): Promise<ApiResponse> {
    this.calls.push(request);
    return this.respond(request);
  }
}

const ok = (body = '{"ok":true}'): ApiResponse => ({ status: 200, headers: {}, body });
const status =
  (code: number, headers: Record<string, string> = {}) =>
  () =>
    Promise.resolve<ApiResponse>({ status: code, headers, body: '' });

async function setup(config: Partial<Config> = {}, registryIds = ['1']) {
  const clock = new VirtualClock(t0);
  const repository = new InMemoryRepository();
  repository.putRegistries(
    registryIds.map((id) => ({
      id,
      providerId: 'p1',
      endpoint: `/q/${id}`,
      httpMethod: 'POST',
      body: { id },
      slot: 0,
      enabled: true,
    })),
  );
  await repository.insertExecutions(
    registryIds.map((id) => ({ ...key(id), providerId: 'p1' })),
    t0,
  );
  const api = new ScriptedApi();
  const retryQueue = new InMemoryStandardQueue(clock, { visibilityTimeoutS: 30 });
  const deadLetterQueue = new InMemoryFifoQueue(clock, { visibilityTimeoutS: 30 });
  const objectStore = new InMemoryObjectStore();
  const logger = new InMemoryLogger();
  const metrics = new InMemoryMetrics();
  const deps = {
    repository,
    api,
    retryQueue,
    deadLetterQueue,
    objectStore,
    clock,
    logger,
    metrics,
    config: { ...defaults, ...config },
    random: () => 0.5,
  };
  return { ...deps, worker: new Worker(deps) };
}

const job = (registryId = '1', overrides: Partial<JobMessage> = {}): string =>
  JSON.stringify({ ...newJobMessage(registryId, 'p1', day, 'DISPATCH', t0), ...overrides });

function retried(queue: InMemoryStandardQueue): JobMessage[] {
  return queue.peekBodies().map((body) => {
    const parsed = parseJobMessage(body);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.message;
  });
}

const deadLetters = (queue: InMemoryFifoQueue): DeadLetter[] =>
  queue.peekBodies().map((b) => JSON.parse(b) as DeadLetter);

/** Opens the circuit of `p1` at `t0` (open until t0 + 60 s). */
async function openCircuit(repository: InMemoryRepository): Promise<CircuitState> {
  let state = initialCircuit(defaults, t0);
  for (let i = 0; i < defaults.cbFailureThreshold; i++) {
    state = transition(state, { type: 'FAILURE', owner: 'x' }, t0, defaults);
  }
  await repository.compareAndSetCircuit('p1', undefined, state);
  return state;
}

describe('Worker: success', () => {
  it('calls the API once with the idempotency headers and stores the result', async () => {
    const { worker, api, repository, metrics, retryQueue, deadLetterQueue } = await setup();

    expect(await worker.handle(job())).toBe('SUCCEEDED');

    expect(api.calls).toEqual([
      {
        method: 'POST',
        endpoint: '/q/1',
        body: { id: '1' },
        headers: { 'Idempotency-Key': '1#2026-03-01', 'X-Provider-Id': 'p1' },
        timeoutMs: 10_000,
      },
    ]);
    expect(await repository.getExecution(key())).toMatchObject({
      status: 'SUCCEEDED',
      attempt: 1,
      lastHttpStatus: 200,
      finishedAt: t0,
    });
    expect(repository.getResult(key())).toMatchObject({
      httpStatus: 200,
      response: { ok: true },
      responseS3Key: null,
    });
    expect(metrics.total('JobsSucceeded')).toBe(1);
    expect(metrics.values('DownstreamLatency', { provider: 'p1' })).toEqual([0]);
    expect(retryQueue.stats().available + deadLetterQueue.stats().available).toBe(0);
  });

  it('stores a payload above resultInlineMaxBytes in the object store', async () => {
    const { worker, api, repository, objectStore } = await setup({ resultInlineMaxBytes: 10 });
    api.respond = () => Promise.resolve(ok('{"big":"0123456789"}'));
    await worker.handle(job());
    expect(repository.getResult(key())).toMatchObject({
      response: null,
      responseS3Key: 'results/2026-03-01/1.json',
    });
    expect(objectStore.get('results/2026-03-01/1.json')).toBe('{"big":"0123456789"}');
  });

  it('keeps a non-JSON body as a JSON string', async () => {
    const { worker, api, repository } = await setup();
    api.respond = () => Promise.resolve(ok('plain text'));
    await worker.handle(job());
    expect(repository.getResult(key())?.response).toBe('plain text');
  });

  it('runs through the Lambda handler', async () => {
    const deps = await setup();
    const handler = createWorkerHandler(deps);
    expect(await handler({ Records: [{ messageId: 'm1', body: job() }] })).toEqual(['SUCCEEDED']);
  });
});

describe('Worker: retryable errors', () => {
  it('schedules a retry with backoff, counting the attempt and the breaker failure', async () => {
    const { worker, api, repository, retryQueue, metrics } = await setup();
    api.respond = status(503);

    expect(await worker.handle(job())).toBe('RETRY_SCHEDULED');

    // backoff(1) with random = 0.5: floor(0.5 × 11) = 5 s.
    expect(retryQueue.nextVisibilityAt()).toEqual(new Date(t0.getTime() + 5_000));
    expect(retried(retryQueue)).toEqual([]); // still delayed
    expect(await repository.getExecution(key())).toMatchObject({
      status: 'RETRYING',
      attempt: 1,
      seq: 1,
      nextAttemptAt: new Date(t0.getTime() + 5_000),
      lastHttpStatus: 503,
      lastErrorType: 'HTTP_503',
    });
    expect((await repository.getCircuit('p1'))?.consecutiveFailures).toBe(1);
    expect(metrics.total('RetryScheduled')).toBe(1);
  });

  it('sends the next message with attempt + 1 and seq + 1', async () => {
    const { worker, api, retryQueue, clock } = await setup();
    api.respond = status(500);
    await worker.handle(job());
    clock.advanceSeconds(5);
    expect(retried(retryQueue)).toEqual([
      expect.objectContaining({ jobId: '1#2026-03-01', attempt: 1, seq: 1, reason: 'RETRY' }),
    ]);
  });

  it('honours Retry-After', async () => {
    const { worker, api, retryQueue } = await setup();
    api.respond = status(429, { 'Retry-After': '120' });
    await worker.handle(job());
    expect(retryQueue.nextVisibilityAt()).toEqual(new Date(t0.getTime() + 120_000));
  });

  it('retries a network error thrown by the client', async () => {
    const { worker, api, repository, logger } = await setup();
    api.respond = () =>
      Promise.reject(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    expect(await worker.handle(job())).toBe('RETRY_SCHEDULED');
    expect(await repository.getExecution(key())).toMatchObject({
      status: 'RETRYING',
      lastErrorType: 'NETWORK_ECONNRESET',
      lastHttpStatus: null,
    });
    expect(logger.find('internal API call failed')).toHaveLength(1);
  });

  it('fails as EXHAUSTED once maxAttempts calls were made', async () => {
    const { worker, api, repository, retryQueue, deadLetterQueue, clock, metrics } = await setup({
      maxAttempts: 2,
    });
    api.respond = status(502);
    expect(await worker.handle(job())).toBe('RETRY_SCHEDULED');
    clock.advanceSeconds(900);
    const [next] = retryQueue.receive();

    expect(await worker.handle(next?.body ?? '')).toBe('FAILED_EXHAUSTED');

    expect(api.calls).toHaveLength(2);
    expect(await repository.getExecution(key())).toMatchObject({
      status: 'FAILED_EXHAUSTED',
      attempt: 2,
      lastErrorType: 'HTTP_502',
    });
    expect(deadLetters(deadLetterQueue)).toEqual([
      expect.objectContaining({
        reason: 'EXHAUSTED',
        error: 'HTTP_502',
        message: expect.objectContaining({ jobId: '1#2026-03-01', seq: 1 }) as unknown,
      }),
    ]);
    expect(metrics.total('JobsFailed', { reason: 'EXHAUSTED' })).toBe(1);
  });

  it('throws when the retry send fails, leaving a RETRYING row the redelivery can claim', async () => {
    const { worker, api, repository, retryQueue } = await setup();
    api.respond = status(503);
    retryQueue.failSend = () => true;

    await expect(worker.handle(job())).rejects.toThrow('injected');
    expect((await repository.getExecution(key()))?.status).toBe('RETRYING');

    retryQueue.failSend = undefined;
    api.respond = () => Promise.resolve(ok());
    expect(await worker.handle(job())).toBe('SUCCEEDED');
    expect((await repository.getExecution(key()))?.attempt).toBe(2);
  });
});

describe('Worker: non-retryable errors', () => {
  it('fails a 4xx without retrying and without touching the breaker', async () => {
    const { worker, api, repository, deadLetterQueue, retryQueue, metrics } = await setup();
    api.respond = status(422);

    expect(await worker.handle(job())).toBe('FAILED_NON_RETRYABLE');

    expect(await repository.getExecution(key())).toMatchObject({
      status: 'FAILED_NON_RETRYABLE',
      lastHttpStatus: 422,
      lastErrorType: 'HTTP_422',
    });
    expect(deadLetterQueue.receive()[0]).toMatchObject({ groupId: 'p1' });
    expect(retryQueue.stats().available).toBe(0);
    expect(await repository.getCircuit('p1')).toBeUndefined();
    expect(metrics.total('JobsFailed', { reason: 'NON_RETRYABLE' })).toBe(1);
    expect(metrics.total('CredentialErrors')).toBe(0);
  });

  it('raises the credential alarm on 401 and 403', async () => {
    const { worker, api, metrics } = await setup({}, ['1', '2']);
    api.respond = status(401);
    await worker.handle(job('1'));
    api.respond = status(403);
    await worker.handle(job('2'));
    expect(metrics.total('CredentialErrors', { provider: 'p1' })).toBe(2);
  });

  it('throws when the DLQ send fails, before writing the terminal status', async () => {
    const { worker, api, repository, deadLetterQueue } = await setup();
    api.respond = status(404);
    deadLetterQueue.failSend = () => true;
    await expect(worker.handle(job())).rejects.toThrow('injected');
    expect((await repository.getExecution(key()))?.status).toBe('IN_PROGRESS');
  });

  it('fails without calling when the registry is missing or disabled', async () => {
    const { worker, api, repository } = await setup({}, ['1', '2']);
    repository.putRegistries([
      {
        id: '2',
        providerId: 'p1',
        endpoint: '/q',
        httpMethod: 'POST',
        body: {},
        slot: 0,
        enabled: false,
      },
    ]);
    await repository.insertExecutions([{ ...key('3'), providerId: 'p1' }], t0);

    expect(await worker.handle(job('2'))).toBe('FAILED_NON_RETRYABLE');
    expect(await worker.handle(job('3'))).toBe('FAILED_NON_RETRYABLE');
    expect(api.calls).toHaveLength(0);
    expect((await repository.getExecution(key('2')))?.lastErrorType).toBe('REGISTRY_DISABLED');
    expect((await repository.getExecution(key('3')))?.lastErrorType).toBe('REGISTRY_NOT_FOUND');
  });
});

describe('Worker: circuit breaker', () => {
  it('defers while OPEN without calling and without consuming an attempt', async () => {
    const { worker, api, repository, retryQueue, clock, metrics } = await setup();
    await openCircuit(repository);

    expect(await worker.handle(job())).toBe('DEFERRED');

    expect(api.calls).toHaveLength(0);
    // until - now = 60 s, plus jitter floor(0.5 × 31) = 15 s.
    expect(retryQueue.nextVisibilityAt()).toEqual(new Date(t0.getTime() + 75_000));
    expect(await repository.getExecution(key())).toMatchObject({
      status: 'RETRYING',
      attempt: 0,
      seq: 1,
    });
    clock.advanceSeconds(75);
    expect(retried(retryQueue)).toEqual([
      expect.objectContaining({ attempt: 0, seq: 1, reason: 'CIRCUIT_DEFER' }),
    ]);
    expect(metrics.total('JobsDeferred', { provider: 'p1' })).toBe(1);
  });

  it('opens after cbFailureThreshold consecutive retryable failures and defers the next job', async () => {
    const ids = ['1', '2', '3', '4', '5', '6'];
    const { worker, api, metrics, logger } = await setup({}, ids);
    api.respond = status(503);
    for (const id of ids.slice(0, 5)) await worker.handle(job(id));

    expect(await worker.handle(job('6'))).toBe('DEFERRED');
    expect(api.calls).toHaveLength(5);
    expect(metrics.dimensionsOf('CircuitStateChange')).toEqual([
      { provider: 'p1', from: 'CLOSED', to: 'OPEN' },
    ]);
    expect(logger.find('circuit state change')[0]?.level).toBe('warn');
  });

  it('makes the HALF_OPEN probe call once the cooldown is over and closes on success', async () => {
    const { worker, api, repository, clock, metrics } = await setup();
    await openCircuit(repository);
    clock.advanceSeconds(60);

    expect(await worker.handle(job())).toBe('SUCCEEDED');

    expect(api.calls).toHaveLength(1);
    expect(await repository.getCircuit('p1')).toMatchObject({
      state: 'CLOSED',
      consecutiveFailures: 0,
    });
    expect(metrics.dimensionsOf('CircuitStateChange').map((d) => `${d.from}>${d.to}`)).toEqual([
      'OPEN>HALF_OPEN',
      'HALF_OPEN>CLOSED',
    ]);
  });

  it('reopens with a doubled cooldown when the probe fails', async () => {
    const { worker, api, repository, clock } = await setup();
    await openCircuit(repository);
    clock.advanceSeconds(60);
    api.respond = status(503);

    expect(await worker.handle(job())).toBe('RETRY_SCHEDULED');
    expect(await repository.getCircuit('p1')).toMatchObject({
      state: 'OPEN',
      cooldownS: 120,
      openUntil: new Date(t0.getTime() + 180_000),
    });
  });

  it('closes when the probe gets a non-retryable answer (the provider is up)', async () => {
    const { worker, api, repository, clock } = await setup();
    await openCircuit(repository);
    clock.advanceSeconds(60);
    api.respond = status(404);
    expect(await worker.handle(job())).toBe('FAILED_NON_RETRYABLE');
    expect((await repository.getCircuit('p1'))?.state).toBe('CLOSED');
  });

  it('defers while another job holds the HALF_OPEN probe', async () => {
    const { worker, api, repository, clock } = await setup({}, ['1', '2']);
    const open = await openCircuit(repository);
    clock.advanceSeconds(60);
    const halfOpen = transition(
      open,
      { type: 'ACQUIRE_PROBE', owner: 'other' },
      clock.now(),
      defaults,
    );
    await repository.compareAndSetCircuit('p1', open, halfOpen);

    expect(await worker.handle(job())).toBe('DEFERRED');
    expect(api.calls).toHaveLength(0);
  });
});

describe('Worker: duplicates, claims and deadlines', () => {
  it('ACKs a duplicate without calling the API', async () => {
    const { worker, api, repository } = await setup();
    await repository.claimExecution(key(), t0, defaults.staleAfterS); // another Worker has it

    expect(await worker.handle(job())).toBe('DUPLICATE');
    expect(api.calls).toHaveLength(0);
  });

  it('ACKs a message for a job that already finished', async () => {
    const { worker, api } = await setup();
    await worker.handle(job());
    expect(await worker.handle(job())).toBe('DUPLICATE');
    expect(api.calls).toHaveLength(1);
  });

  it('ACKs a deferred duplicate of a job that already finished', async () => {
    const { worker, repository, retryQueue } = await setup();
    await worker.handle(job());
    await openCircuit(repository);

    expect(await worker.handle(job())).toBe('DUPLICATE');
    expect(retryQueue.stats().available).toBe(0);
  });

  it('discards the result when its claim was taken over during the call', async () => {
    const { worker, api, repository, clock } = await setup();
    api.respond = async () => {
      clock.advanceSeconds(defaults.staleAfterS + 1);
      await repository.claimExecution(key(), clock.now(), defaults.staleAfterS);
      return ok();
    };
    expect(await worker.handle(job())).toBe('CLAIM_LOST');
    expect(repository.getResult(key())).toBeUndefined();
    expect((await repository.getExecution(key()))?.status).toBe('IN_PROGRESS');
  });

  it('does not expire a job exactly at the end of its day plus expiryGraceH', async () => {
    const { worker, clock } = await setup();
    clock.advanceTo(new Date('2026-03-02T06:00:00Z'));
    expect(await worker.handle(job())).toBe('SUCCEEDED');
  });

  it('expires a job after the end of its day plus expiryGraceH, without calling', async () => {
    const { worker, api, repository, clock, deadLetterQueue, metrics } = await setup();
    clock.advanceTo(new Date('2026-03-02T06:00:01Z'));

    expect(await worker.handle(job())).toBe('FAILED_EXPIRED');

    expect(api.calls).toHaveLength(0);
    expect(await repository.getExecution(key())).toMatchObject({
      status: 'FAILED_EXPIRED',
      lastErrorType: 'EXPIRED',
    });
    expect(deadLetters(deadLetterQueue)[0]).toMatchObject({ reason: 'EXPIRED' });
    expect(metrics.total('JobsFailed', { reason: 'EXPIRED' })).toBe(1);
  });

  it('ACKs an expired message for a job that already finished', async () => {
    const { worker, clock, deadLetterQueue } = await setup();
    await worker.handle(job());
    clock.advanceTo(new Date('2026-03-03T00:00:00Z'));
    expect(await worker.handle(job())).toBe('DUPLICATE');
    expect(deadLetterQueue.stats().available).toBe(0);
  });

  it('sends an invalid message to the DLQ with INVALID_MESSAGE', async () => {
    const { worker, deadLetterQueue, api } = await setup();
    expect(await worker.handle('not json')).toBe('INVALID_MESSAGE');
    expect(await worker.handle(job('1', { attempt: -1 }))).toBe('INVALID_MESSAGE');
    expect(api.calls).toHaveLength(0);
    expect(deadLetters(deadLetterQueue)).toEqual([
      expect.objectContaining({ reason: 'INVALID_MESSAGE', raw: 'not json' }),
      expect.objectContaining({ reason: 'INVALID_MESSAGE', error: expect.any(String) as unknown }),
    ]);
    expect(deadLetterQueue.receive()[0]?.groupId).toBe('INVALID_MESSAGE');
  });
});
