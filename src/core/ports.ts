import type { CircuitState } from '../common/circuit-breaker.js';
import type {
  DispatchWindow,
  Execution,
  ExecutionKey,
  ExecutionResult,
  ExecutionStatus,
  Registry,
} from './model.js';

/**
 * Ports (CLAUDE.md §8): the core depends only on these interfaces. The in-memory adapters in
 * `src/adapters/memory/` implement them for tests and the simulation; AWS adapters would live in
 * `src/adapters/aws/`. Logger and Metrics are in `src/common/telemetry.ts`.
 */

export interface Clock {
  now(): Date;
}

// ---------------------------------------------------------------------------------------------
// Queues (producer side only: consumers are invoked by the ESM / the simulation harness)
// ---------------------------------------------------------------------------------------------

export interface FifoMessage {
  body: string;
  groupId: string;
  deduplicationId: string;
}

export interface SendBatchResult {
  /** Entries that were not accepted, by index in the request (SQS reports them, it does not throw). */
  failed: readonly { index: number; error: string }[];
}

/** SQS FIFO: the main queue and its DLQ (D5, D9). */
export interface FifoQueue {
  /** Throws when the message is not accepted. A duplicate within the dedup window is accepted. */
  send(message: FifoMessage): Promise<void>;
  /** `SendMessageBatch`: 1..10 entries. */
  sendBatch(messages: readonly FifoMessage[]): Promise<SendBatchResult>;
}

/** SQS standard: the `retry` queue and its DLQ (D7, D9). */
export interface StandardQueue {
  /** `delaySeconds` in 0..900. Throws when the message is not accepted. */
  send(body: string, delaySeconds?: number): Promise<void>;
}

/** Request to the internal API (which runs 2 Lambdas per call). */
export interface ApiRequest {
  method: string;
  endpoint: string;
  body: unknown;
  headers: Readonly<Record<string, string>>;
  timeoutMs: number;
}

export interface ApiResponse {
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
  body: string;
}

/**
 * HTTP client for the internal API. Resolves with any HTTP response (2xx, 4xx or 5xx) and rejects
 * only when there is no response: network errors (`error.code`) or the timeout
 * (`error.name = 'TimeoutError'` / `'AbortError'`).
 */
export interface InternalApi {
  call(request: ApiRequest): Promise<ApiResponse>;
}

/** S3 for result payloads larger than `resultInlineMaxBytes` (D11). */
export interface ObjectStore {
  put(key: string, body: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Repository (Aurora PostgreSQL). Every write is atomic and, where it changes state, conditional.
// ---------------------------------------------------------------------------------------------

export interface RegistryRepository {
  getRegistry(id: string): Promise<Registry | undefined>;
  /**
   * `WHERE slot = $1 AND enabled AND id > $after ORDER BY id LIMIT $limit` (keyset pagination,
   * `after = null` for the first page).
   */
  listRegistriesBySlot(slot: number, after: string | null, limit: number): Promise<Registry[]>;
  /**
   * Enabled registries with `slotFrom <= slot < slotBefore` and no `executions` row for `runDate`,
   * ordered by `(slot, id)` and paginated with a keyset cursor (Reconciler, §6.6 step 2).
   */
  findRegistriesWithoutExecution(
    runDate: string,
    slotFrom: number,
    slotBefore: number,
    after: SlotCursor | null,
    limit: number,
  ): Promise<Registry[]>;
}

export interface SlotCursor {
  slot: number;
  id: string;
}

export interface NewExecution extends ExecutionKey {
  providerId: string;
}

/** Guard of a conditional update: every given field must match the current row. */
export interface ExecutionCondition {
  status: readonly ExecutionStatus[];
  /** Fencing token: the `started_at` written by this Worker's claim. */
  startedAt?: Date;
  startedBefore?: Date;
}

export type ExecutionPatch = Partial<
  Pick<
    Execution,
    | 'status'
    | 'attempt'
    | 'seq'
    | 'startedAt'
    | 'finishedAt'
    | 'nextAttemptAt'
    | 'lastHttpStatus'
    | 'lastErrorType'
    | 'lastError'
  >
>;

export interface ExecutionQuery {
  runDate: string;
  status: ExecutionStatus;
  startedBefore?: Date;
  enqueuedBefore?: Date;
  /** Keyset cursor on `registry_id`. */
  after?: string;
  limit: number;
}

export interface ExecutionStats {
  total: number;
  byStatus: Record<ExecutionStatus, number>;
  byProvider: Record<string, Partial<Record<ExecutionStatus, number>>>;
}

export interface ExecutionRepository {
  getExecution(key: ExecutionKey): Promise<Execution | undefined>;
  /**
   * `INSERT ... ('ENQUEUED') ON CONFLICT DO NOTHING RETURNING registry_id` (D4): returns only the
   * registry ids that were inserted; existing rows were already dispatched.
   */
  insertExecutions(rows: readonly NewExecution[], now: Date): Promise<string[]>;
  /**
   * The rows among `registryIds` that are still `ENQUEUED` for `runDate`. The Dispatcher uses it
   * to re-send a window that a previous run left in `PROCESSING` (inserted but maybe not sent).
   */
  findEnqueuedExecutions(runDate: string, registryIds: readonly string[]): Promise<Execution[]>;
  /**
   * Worker claim (§6.2 step 4): `ENQUEUED | RETRYING`, or `IN_PROGRESS` with
   * `started_at < now - staleAfterS`, becomes `IN_PROGRESS` with `started_at = now` and
   * `attempt + 1`. Returns the updated row, or `undefined` when nothing matched (duplicate or done).
   * The attempt is counted at claim time, so a Worker that crashes mid-call still consumes it.
   */
  claimExecution(key: ExecutionKey, now: Date, staleAfterS: number): Promise<Execution | undefined>;
  /** Applies `patch` only if `condition` holds; returns whether the row changed. */
  updateExecution(
    key: ExecutionKey,
    condition: ExecutionCondition,
    patch: ExecutionPatch,
  ): Promise<boolean>;
  /**
   * In one transaction: upsert the `results` row and mark the execution `SUCCEEDED`, only if
   * `condition` holds. Returns `false` (and writes nothing) otherwise.
   */
  succeedExecution(
    key: ExecutionKey,
    condition: ExecutionCondition,
    result: ExecutionResult,
  ): Promise<boolean>;
  findExecutions(query: ExecutionQuery): Promise<Execution[]>;
  executionStats(runDate: string): Promise<ExecutionStats>;
}

export interface DispatchWindowRepository {
  getDispatchWindow(runDate: string, slot: number): Promise<DispatchWindow | undefined>;
  /** `INSERT ... ON CONFLICT DO UPDATE SET status = 'PROCESSING'`; keeps the first `started_at`. */
  beginDispatchWindow(runDate: string, slot: number, now: Date): Promise<void>;
  /**
   * Marks the window `COMPLETED` with `jobs_dispatched` = the slot's registries that have an
   * execution for the day (set, not added: a recovered window is not counted twice).
   */
  completeDispatchWindow(
    runDate: string,
    slot: number,
    jobsDispatched: number,
    now: Date,
  ): Promise<void>;
}

export interface CircuitRepository {
  /** `undefined` when the provider has no row (it is `CLOSED`). */
  getCircuit(providerId: string): Promise<CircuitState | undefined>;
  /**
   * Compare-and-set: writes `next` only if the row still equals `expected` (`undefined` = no row,
   * an `INSERT ... ON CONFLICT DO NOTHING`). Concurrent Workers race here and only one wins.
   */
  compareAndSetCircuit(
    providerId: string,
    expected: CircuitState | undefined,
    next: CircuitState,
  ): Promise<boolean>;
}

export type Repository = RegistryRepository &
  ExecutionRepository &
  DispatchWindowRepository &
  CircuitRepository;
