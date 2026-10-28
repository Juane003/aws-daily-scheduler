import { VirtualClock } from '../adapters/memory/clock.js';
import { InMemoryFifoQueue } from '../adapters/memory/fifo-queue.js';
import { InMemoryLogger } from '../adapters/memory/logger.js';
import { InMemoryMetrics } from '../adapters/memory/metrics.js';
import { InMemoryObjectStore } from '../adapters/memory/object-store.js';
import { InMemoryRepository } from '../adapters/memory/repository.js';
import { InMemoryStandardQueue } from '../adapters/memory/standard-queue.js';
import type { CircuitState } from '../common/circuit-breaker.js';
import { defaults, type Config } from '../common/config.js';
import type { Logger } from '../common/telemetry.js';
import type { ExecutionKey, ExecutionResult, ExecutionStatus, Registry } from '../core/model.js';
import type { Clock, ExecutionCondition } from '../core/ports.js';
import type { WorkerOutcome } from '../core/execute/worker.js';
import { createDispatcherHandler } from '../handlers/dispatcher.js';
import { createReconcilerHandler } from '../handlers/reconciler.js';
import { createRequeueHandler } from '../handlers/requeue.js';
import { createWorkerHandler, type SqsEvent } from '../handlers/worker.js';
import { ApiSimulator, DEFAULT_PROFILE, type ProviderProfile } from './api-simulator.js';
import { createRng } from './registries.js';
import { VirtualTimers } from './virtual-timers.js';

/**
 * In-memory simulation of the whole pipeline on a virtual clock — a test harness, not a benchmark.
 * It wires the four handlers to the in-memory adapters and plays the roles AWS plays in the target
 * design:
 *
 * - EventBridge Scheduler: a Dispatcher tick every minute, a Reconciler run every hour.
 * - The FIFO event source mapping: receives one message at a time (`BatchSize = 1`), up to
 *   `esmMaxConcurrency` invocations in flight; ACK = delete on success, nothing on an exception.
 * - The `retry` event source mapping: batches of 10 with `ReportBatchItemFailures`.
 *
 * Time only moves when nothing can progress at the current instant: the harness then jumps to the
 * next event (a simulated API response, a visibility timeout, a delayed message, a schedule).
 */

export class SimulatedCrash extends Error {
  override readonly name = 'SimulatedCrash';
}

/**
 * Repository with fault injection and a log of breaker writes.
 * - `crashBeforeCall`: the Worker dies after its claim, before calling the API.
 * - `crashAfterCall`: the Worker dies after a successful call, before writing the result.
 * Each entry is a registry id and fires once.
 */
export class SimRepository extends InMemoryRepository {
  readonly crashBeforeCall = new Set<string>();
  readonly crashAfterCall = new Set<string>();
  readonly circuitHistory: { at: number; providerId: string; state: CircuitState }[] = [];

  constructor(private readonly clock: Clock) {
    super();
  }

  override getRegistry(id: string): Promise<Registry | undefined> {
    if (this.crashBeforeCall.delete(id)) {
      return Promise.reject(new SimulatedCrash(`crash before call: ${id}`));
    }
    return super.getRegistry(id);
  }

  override succeedExecution(
    key: ExecutionKey,
    condition: ExecutionCondition,
    result: ExecutionResult,
  ): Promise<boolean> {
    if (this.crashAfterCall.delete(key.registryId)) {
      return Promise.reject(new SimulatedCrash(`crash after call: ${key.registryId}`));
    }
    return super.succeedExecution(key, condition, result);
  }

  override async compareAndSetCircuit(
    providerId: string,
    expected: CircuitState | undefined,
    next: CircuitState,
  ): Promise<boolean> {
    const written = await super.compareAndSetCircuit(providerId, expected, next);
    if (written)
      this.circuitHistory.push({ at: this.clock.now().getTime(), providerId, state: next });
    return written;
  }
}

export interface HarnessOptions {
  start: Date | string;
  registries: Iterable<Registry>;
  /** Per-provider profile; unspecified providers use {@link DEFAULT_PROFILE}. */
  profiles?: Readonly<Record<string, Partial<ProviderProfile>>>;
  config?: Partial<Config>;
  /** `MaximumConcurrency` of the Worker's event source mapping. */
  esmMaxConcurrency?: number;
  seed?: number;
  logger?: Logger;
  /** Offset of the hourly Reconciler run within the hour. */
  reconcileOffsetMs?: number;
}

export class Harness {
  readonly clock: VirtualClock;
  readonly timers: VirtualTimers;
  readonly config: Config;
  readonly repository: SimRepository;
  readonly fifo: InMemoryFifoQueue;
  readonly deadLetterQueue: InMemoryFifoQueue;
  readonly retryQueue: InMemoryStandardQueue;
  readonly retryDeadLetterQueue: InMemoryStandardQueue;
  readonly objectStore = new InMemoryObjectStore();
  readonly metrics = new InMemoryMetrics();
  readonly logger: Logger;
  readonly api: ApiSimulator;

  readonly workerOutcomes = new Map<WorkerOutcome, number>();
  readonly workerErrors: unknown[] = [];

  private readonly dispatch: () => Promise<unknown>;
  private readonly reconcile: () => Promise<unknown>;
  private readonly work: (event: SqsEvent) => Promise<WorkerOutcome[]>;
  private readonly requeue: ReturnType<typeof createRequeueHandler>;
  private readonly esmMaxConcurrency: number;
  private nextTickMs: number;
  private nextReconcileMs: number;
  private inFlight = 0;
  private completed = 0;

  constructor(options: HarnessOptions) {
    this.clock = new VirtualClock(options.start);
    this.timers = new VirtualTimers(this.clock);
    this.config = { ...defaults, ...options.config };
    this.logger = options.logger ?? new InMemoryLogger();
    this.esmMaxConcurrency = options.esmMaxConcurrency ?? 100;
    const random = createRng(options.seed ?? 1);

    this.repository = new SimRepository(this.clock);
    this.repository.putRegistries(options.registries);
    const visibilityTimeoutS = this.config.visibilityTimeoutS;
    this.deadLetterQueue = new InMemoryFifoQueue(this.clock, { visibilityTimeoutS });
    this.fifo = new InMemoryFifoQueue(this.clock, {
      visibilityTimeoutS,
      redrive: { deadLetterQueue: this.deadLetterQueue, maxReceiveCount: 3 },
    });
    this.retryDeadLetterQueue = new InMemoryStandardQueue(this.clock, { visibilityTimeoutS: 30 });
    this.retryQueue = new InMemoryStandardQueue(this.clock, {
      visibilityTimeoutS: 30,
      redrive: { deadLetterQueue: this.retryDeadLetterQueue, maxReceiveCount: 3 },
    });

    const profiles = options.profiles ?? {};
    this.api = new ApiSimulator(
      this.clock,
      this.timers,
      (providerId) => ({ ...DEFAULT_PROFILE, ...profiles[providerId] }),
      random,
    );

    const common = {
      clock: this.clock,
      logger: this.logger,
      metrics: this.metrics,
      config: this.config,
    };
    this.dispatch = createDispatcherHandler({
      ...common,
      repository: this.repository,
      queue: this.fifo,
    });
    this.reconcile = createReconcilerHandler({
      ...common,
      repository: this.repository,
      queue: this.fifo,
    });
    this.work = createWorkerHandler({
      ...common,
      repository: this.repository,
      api: this.api,
      retryQueue: this.retryQueue,
      deadLetterQueue: this.deadLetterQueue,
      objectStore: this.objectStore,
      random,
    });
    this.requeue = createRequeueHandler({
      ...common,
      queue: this.fifo,
      deadLetterQueue: this.deadLetterQueue,
    });

    const startMs = this.clock.now().getTime();
    this.nextTickMs = Math.ceil(startMs / 60_000) * 60_000;
    this.nextReconcileMs =
      Math.ceil(startMs / 3_600_000) * 3_600_000 + (options.reconcileOffsetMs ?? 30_000);
  }

  /** Runs the simulation until `end` (inclusive of events at `end`). */
  async runUntil(end: Date | string): Promise<void> {
    const endMs = new Date(end).getTime();
    for (;;) {
      await this.runSchedules();
      await this.settle();
      const nowMs = this.clock.now().getTime();
      // Drop expired visibility entries, so the queues report their next real event.
      this.fifo.stats();
      this.retryQueue.stats();
      const candidates = [
        this.timers.nextAt(),
        this.fifo.nextVisibilityAt()?.getTime(),
        this.retryQueue.nextVisibilityAt()?.getTime(),
        this.nextTickMs,
        this.nextReconcileMs,
      ].filter((t): t is number => t !== undefined && t > nowMs);
      const next = Math.min(...candidates);
      if (!Number.isFinite(next) || next > endMs) break;
      this.clock.advanceTo(new Date(next));
    }
    if (this.clock.now().getTime() < endMs) this.clock.advanceTo(new Date(endMs));
  }

  /** Count of executions by status, for one run date or all. */
  statusCounts(runDate?: string): Partial<Record<ExecutionStatus, number>> {
    const counts: Partial<Record<ExecutionStatus, number>> = {};
    for (const e of this.repository.allExecutions()) {
      if (runDate !== undefined && e.runDate !== runDate) continue;
      counts[e.status] = (counts[e.status] ?? 0) + 1;
    }
    return counts;
  }

  /** Messages still queued or in flight anywhere except the DLQs, plus pending simulated calls. */
  pendingWork(): number {
    const fifo = this.fifo.stats();
    const retry = this.retryQueue.stats();
    return fifo.available + fifo.inFlight + retry.available + retry.inFlight + this.inFlight;
  }

  private async runSchedules(): Promise<void> {
    const nowMs = this.clock.now().getTime();
    while (this.nextTickMs <= nowMs) {
      await this.dispatch();
      this.nextTickMs += 60_000;
    }
    while (this.nextReconcileMs <= nowMs) {
      await this.reconcile();
      this.nextReconcileMs += 3_600_000;
    }
  }

  /** Lets everything that can happen at the current instant happen. */
  private async settle(): Promise<void> {
    for (;;) {
      const before = this.completed;
      const fired = this.timers.fireDue();
      const started = this.pollWorkers() + (await this.pollRequeue());
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (fired === 0 && started === 0 && this.completed === before) return;
    }
  }

  /** FIFO event source mapping: `BatchSize = 1`, bounded concurrency. */
  private pollWorkers(): number {
    let started = 0;
    while (this.inFlight < this.esmMaxConcurrency) {
      const [message] = this.fifo.receive(1);
      if (message === undefined) break;
      this.inFlight++;
      started++;
      this.work({ Records: [{ messageId: message.messageId, body: message.body }] })
        .then(
          ([outcome]) => {
            this.fifo.delete(message.receiptHandle);
            if (outcome !== undefined) {
              this.workerOutcomes.set(outcome, (this.workerOutcomes.get(outcome) ?? 0) + 1);
            }
          },
          (error: unknown) => {
            // No ACK: SQS redelivers after the visibility timeout.
            this.workerErrors.push(error);
          },
        )
        .finally(() => {
          this.inFlight--;
          this.completed++;
        });
    }
    return started;
  }

  /** `retry` event source mapping: batches of 10, `ReportBatchItemFailures`. */
  private async pollRequeue(): Promise<number> {
    let handled = 0;
    for (
      let batch = this.retryQueue.receive(10);
      batch.length > 0;
      batch = this.retryQueue.receive(10)
    ) {
      const response = await this.requeue({
        Records: batch.map((m) => ({ messageId: m.messageId, body: m.body })),
      });
      const failed = new Set(response.batchItemFailures.map((f) => f.itemIdentifier));
      for (const m of batch) if (!failed.has(m.messageId)) this.retryQueue.delete(m.receiptHandle);
      handled += batch.length;
    }
    return handled;
  }
}
