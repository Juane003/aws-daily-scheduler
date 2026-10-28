import type { CircuitState } from '../../common/circuit-breaker.js';
import { SLOTS_PER_DAY } from '../../common/slot.js';
import {
  EXECUTION_STATUSES,
  type DispatchWindow,
  type Execution,
  type ExecutionKey,
  type ExecutionResult,
  type ExecutionStatus,
  type Registry,
} from '../../core/model.js';
import type {
  ExecutionCondition,
  ExecutionPatch,
  ExecutionQuery,
  ExecutionStats,
  NewExecution,
  Repository,
  SlotCursor,
} from '../../core/ports.js';

/**
 * In-memory stand-in for Aurora PostgreSQL. It reproduces what the design depends on:
 *
 * - `PRIMARY KEY (registry_id, run_date)` on `executions`: an insert of an existing key is a no-op
 *   (`ON CONFLICT DO NOTHING`), so dispatching twice never creates two jobs.
 * - Conditional updates are atomic: each check-and-write runs synchronously before the returned
 *   promise settles, so concurrent callers (interleaved at `await` points) cannot both win.
 * - Keyset pagination in `id` order (ids compared as integers, like `BIGINT`).
 *
 * Rows are returned as shallow copies, so callers cannot change stored state by mutating them.
 */
export class InMemoryRepository implements Repository {
  private readonly registries = new Map<string, Registry>();
  /** slot → registry ids, sorted. Plays the role of the `(slot, id)` index. */
  private readonly bySlot = new Map<number, string[]>();
  private readonly executions = new Map<string, Execution>();
  /** `runDate|status` → registry ids. Plays the role of the `(run_date, status)` index. */
  private readonly byStatus = new Map<string, Set<string>>();
  private readonly results = new Map<string, ExecutionResult>();
  private readonly windows = new Map<string, DispatchWindow>();
  private readonly circuits = new Map<string, CircuitState>();

  // -------------------------------------------------------------------------------------------
  // Registries
  // -------------------------------------------------------------------------------------------

  /** Seeds or updates registries (adapter-only; the core never writes `registries`). */
  putRegistries(rows: Iterable<Registry>): void {
    for (const row of rows) {
      if (!Number.isInteger(row.slot) || row.slot < 0 || row.slot >= SLOTS_PER_DAY) {
        throw new RangeError(`registry ${row.id}: slot ${row.slot} out of range`);
      }
      const previous = this.registries.get(row.id);
      if (previous !== undefined && previous.slot !== row.slot) {
        const ids = this.bySlot.get(previous.slot) ?? [];
        ids.splice(upperBound(ids, row.id) - 1, 1);
      }
      if (previous === undefined || previous.slot !== row.slot)
        insertSorted(this.slotIds(row.slot), row.id);
      this.registries.set(row.id, { ...row });
    }
  }

  getRegistry(id: string): Promise<Registry | undefined> {
    const row = this.registries.get(id);
    return Promise.resolve(row && { ...row });
  }

  listRegistriesBySlot(slot: number, after: string | null, limit: number): Promise<Registry[]> {
    const ids = this.bySlot.get(slot) ?? [];
    const out: Registry[] = [];
    for (let i = after === null ? 0 : upperBound(ids, after); i < ids.length; i++) {
      if (out.length >= limit) break;
      const row = this.registries.get(ids[i] as string);
      if (row?.enabled === true) out.push({ ...row });
    }
    return Promise.resolve(out);
  }

  findRegistriesWithoutExecution(
    runDate: string,
    slotFrom: number,
    slotBefore: number,
    after: SlotCursor | null,
    limit: number,
  ): Promise<Registry[]> {
    const out: Registry[] = [];
    for (
      let slot = Math.max(slotFrom, after?.slot ?? 0);
      slot < slotBefore && out.length < limit;
      slot++
    ) {
      const ids = this.bySlot.get(slot) ?? [];
      const start = after !== null && slot === after.slot ? upperBound(ids, after.id) : 0;
      for (let i = start; i < ids.length && out.length < limit; i++) {
        const id = ids[i] as string;
        const row = this.registries.get(id);
        if (row?.enabled === true && !this.executions.has(keyOf(id, runDate))) out.push({ ...row });
      }
    }
    return Promise.resolve(out);
  }

  // -------------------------------------------------------------------------------------------
  // Executions and results
  // -------------------------------------------------------------------------------------------

  getExecution(key: ExecutionKey): Promise<Execution | undefined> {
    const row = this.executions.get(keyOf(key.registryId, key.runDate));
    return Promise.resolve(row && { ...row });
  }

  insertExecutions(rows: readonly NewExecution[], now: Date): Promise<string[]> {
    const inserted: string[] = [];
    for (const row of rows) {
      const key = keyOf(row.registryId, row.runDate);
      if (this.executions.has(key)) continue;
      const execution: Execution = {
        registryId: row.registryId,
        runDate: row.runDate,
        providerId: row.providerId,
        status: 'ENQUEUED',
        attempt: 0,
        seq: 0,
        enqueuedAt: now,
        startedAt: null,
        finishedAt: null,
        nextAttemptAt: null,
        lastHttpStatus: null,
        lastErrorType: null,
        lastError: null,
      };
      this.executions.set(key, execution);
      this.index(execution);
      inserted.push(row.registryId);
    }
    return Promise.resolve(inserted);
  }

  findEnqueuedExecutions(runDate: string, registryIds: readonly string[]): Promise<Execution[]> {
    const out: Execution[] = [];
    for (const id of registryIds) {
      const row = this.executions.get(keyOf(id, runDate));
      if (row?.status === 'ENQUEUED') out.push({ ...row });
    }
    return Promise.resolve(out);
  }

  claimExecution(
    key: ExecutionKey,
    now: Date,
    staleAfterS: number,
  ): Promise<Execution | undefined> {
    const row = this.executions.get(keyOf(key.registryId, key.runDate));
    if (row === undefined) return Promise.resolve(undefined);
    const stale =
      row.status === 'IN_PROGRESS' &&
      row.startedAt !== null &&
      row.startedAt.getTime() < now.getTime() - staleAfterS * 1000;
    if (row.status !== 'ENQUEUED' && row.status !== 'RETRYING' && !stale) {
      return Promise.resolve(undefined);
    }
    this.apply(row, {
      status: 'IN_PROGRESS',
      startedAt: now,
      attempt: row.attempt + 1,
      nextAttemptAt: null,
    });
    return Promise.resolve({ ...row });
  }

  updateExecution(
    key: ExecutionKey,
    condition: ExecutionCondition,
    patch: ExecutionPatch,
  ): Promise<boolean> {
    const row = this.executions.get(keyOf(key.registryId, key.runDate));
    if (row === undefined || !matches(row, condition)) return Promise.resolve(false);
    this.apply(row, patch);
    return Promise.resolve(true);
  }

  succeedExecution(
    key: ExecutionKey,
    condition: ExecutionCondition,
    result: ExecutionResult,
  ): Promise<boolean> {
    const k = keyOf(key.registryId, key.runDate);
    const row = this.executions.get(k);
    if (row === undefined || !matches(row, condition)) return Promise.resolve(false);
    this.results.set(k, { ...result, registryId: key.registryId, runDate: key.runDate });
    this.apply(row, {
      status: 'SUCCEEDED',
      finishedAt: result.createdAt,
      lastHttpStatus: result.httpStatus,
      nextAttemptAt: null,
    });
    return Promise.resolve(true);
  }

  findExecutions(query: ExecutionQuery): Promise<Execution[]> {
    const ids = this.byStatus.get(`${query.runDate}|${query.status}`) ?? new Set<string>();
    const out: Execution[] = [];
    for (const id of ids) {
      const row = this.executions.get(keyOf(id, query.runDate));
      if (row === undefined) continue;
      if (query.after !== undefined && compareIds(id, query.after) <= 0) continue;
      if (query.startedBefore !== undefined && !before(row.startedAt, query.startedBefore)) {
        continue;
      }
      if (query.enqueuedBefore !== undefined && !before(row.enqueuedAt, query.enqueuedBefore)) {
        continue;
      }
      out.push(row);
    }
    out.sort((a, b) => compareIds(a.registryId, b.registryId));
    return Promise.resolve(out.slice(0, query.limit).map((row) => ({ ...row })));
  }

  executionStats(runDate: string): Promise<ExecutionStats> {
    const stats: ExecutionStats = {
      total: 0,
      byStatus: Object.fromEntries(EXECUTION_STATUSES.map((s) => [s, 0])) as Record<
        ExecutionStatus,
        number
      >,
      byProvider: {},
    };
    for (const status of EXECUTION_STATUSES) {
      for (const id of this.byStatus.get(`${runDate}|${status}`) ?? []) {
        const row = this.executions.get(keyOf(id, runDate));
        if (row === undefined) continue;
        stats.total++;
        stats.byStatus[status]++;
        const provider = (stats.byProvider[row.providerId] ??= {});
        provider[status] = (provider[status] ?? 0) + 1;
      }
    }
    return Promise.resolve(stats);
  }

  /** Adapter-only inspection for tests. */
  getResult(key: ExecutionKey): ExecutionResult | undefined {
    const row = this.results.get(keyOf(key.registryId, key.runDate));
    return row && { ...row };
  }

  /** Adapter-only inspection for tests: every execution row. */
  allExecutions(): Execution[] {
    return [...this.executions.values()].map((row) => ({ ...row }));
  }

  // -------------------------------------------------------------------------------------------
  // Dispatch windows
  // -------------------------------------------------------------------------------------------

  getDispatchWindow(runDate: string, slot: number): Promise<DispatchWindow | undefined> {
    const row = this.windows.get(`${runDate}|${slot}`);
    return Promise.resolve(row && { ...row });
  }

  beginDispatchWindow(runDate: string, slot: number, now: Date): Promise<void> {
    const key = `${runDate}|${slot}`;
    const row = this.windows.get(key);
    if (row === undefined) {
      this.windows.set(key, {
        runDate,
        slot,
        status: 'PROCESSING',
        jobsDispatched: 0,
        startedAt: now,
        completedAt: null,
      });
    } else {
      row.status = 'PROCESSING';
    }
    return Promise.resolve();
  }

  completeDispatchWindow(
    runDate: string,
    slot: number,
    jobsDispatched: number,
    now: Date,
  ): Promise<void> {
    const row = this.windows.get(`${runDate}|${slot}`);
    if (row !== undefined) {
      row.status = 'COMPLETED';
      row.jobsDispatched = jobsDispatched;
      row.completedAt = now;
    }
    return Promise.resolve();
  }

  // -------------------------------------------------------------------------------------------
  // Circuits
  // -------------------------------------------------------------------------------------------

  getCircuit(providerId: string): Promise<CircuitState | undefined> {
    const row = this.circuits.get(providerId);
    return Promise.resolve(row && { ...row });
  }

  compareAndSetCircuit(
    providerId: string,
    expected: CircuitState | undefined,
    next: CircuitState,
  ): Promise<boolean> {
    const current = this.circuits.get(providerId);
    const unchanged =
      current === undefined || expected === undefined
        ? current === expected
        : circuitEquals(current, expected);
    if (!unchanged) return Promise.resolve(false);
    this.circuits.set(providerId, { ...next });
    return Promise.resolve(true);
  }

  // -------------------------------------------------------------------------------------------

  private slotIds(slot: number): string[] {
    let ids = this.bySlot.get(slot);
    if (ids === undefined) {
      ids = [];
      this.bySlot.set(slot, ids);
    }
    return ids;
  }

  private apply(row: Execution, patch: ExecutionPatch): void {
    const previous = row.status;
    Object.assign(row, patch);
    if (row.status !== previous) {
      this.byStatus.get(`${row.runDate}|${previous}`)?.delete(row.registryId);
      this.index(row);
    }
  }

  private index(row: Execution): void {
    const key = `${row.runDate}|${row.status}`;
    let ids = this.byStatus.get(key);
    if (ids === undefined) {
      ids = new Set();
      this.byStatus.set(key, ids);
    }
    ids.add(row.registryId);
  }
}

function keyOf(registryId: string, runDate: string): string {
  return `${registryId}#${runDate}`;
}

/** Orders decimal ids numerically, as `BIGINT` does, without converting them. */
export function compareIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Index of the first id greater than `id`. */
function upperBound(ids: readonly string[], id: string): number {
  let lo = 0;
  let hi = ids.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareIds(ids[mid] as string, id) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function insertSorted(ids: string[], id: string): void {
  const last = ids[ids.length - 1];
  // Seeds arrive in id order, so appending is the common case.
  if (last === undefined || compareIds(last, id) < 0) ids.push(id);
  else ids.splice(upperBound(ids, id), 0, id);
}

function matches(row: Execution, condition: ExecutionCondition): boolean {
  if (!condition.status.includes(row.status)) return false;
  if (
    condition.startedAt !== undefined &&
    row.startedAt?.getTime() !== condition.startedAt.getTime()
  ) {
    return false;
  }
  if (condition.startedBefore !== undefined && !before(row.startedAt, condition.startedBefore)) {
    return false;
  }
  return true;
}

function before(value: Date | null, limit: Date): boolean {
  return value !== null && value.getTime() < limit.getTime();
}

function circuitEquals(a: CircuitState, b: CircuitState): boolean {
  return (
    a.state === b.state &&
    a.consecutiveFailures === b.consecutiveFailures &&
    a.cooldownS === b.cooldownS &&
    a.openUntil?.getTime() === b.openUntil?.getTime() &&
    a.halfOpenOwner === b.halfOpenOwner &&
    a.updatedAt.getTime() === b.updatedAt.getTime()
  );
}
