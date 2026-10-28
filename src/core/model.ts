/**
 * Domain rows shared by the core and the adapters. They mirror the tables in
 * `database/migrations/` (CLAUDE.md §4), with camelCase names and `BIGINT` ids as decimal strings.
 */

export const EXECUTION_STATUSES = [
  'ENQUEUED',
  'IN_PROGRESS',
  'RETRYING',
  'SUCCEEDED',
  'FAILED_NON_RETRYABLE',
  'FAILED_EXHAUSTED',
  'FAILED_EXPIRED',
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const TERMINAL_STATUSES: readonly ExecutionStatus[] = [
  'SUCCEEDED',
  'FAILED_NON_RETRYABLE',
  'FAILED_EXHAUSTED',
  'FAILED_EXPIRED',
];

export function isTerminal(status: ExecutionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** A `registries` row: the table of the problem statement plus its slot (D1). */
export interface Registry {
  id: string;
  providerId: string;
  endpoint: string;
  httpMethod: string;
  body: unknown;
  slot: number;
  enabled: boolean;
}

/** Primary key of `executions` and `results` (D12). */
export interface ExecutionKey {
  registryId: string;
  runDate: string;
}

export interface Execution extends ExecutionKey {
  providerId: string;
  status: ExecutionStatus;
  attempt: number;
  seq: number;
  enqueuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  nextAttemptAt: Date | null;
  lastHttpStatus: number | null;
  lastErrorType: string | null;
  lastError: string | null;
}

/** A `results` row: exactly one of `response` / `responseS3Key` is set. */
export interface ExecutionResult extends ExecutionKey {
  httpStatus: number;
  durationMs: number;
  response: unknown;
  responseS3Key: string | null;
  createdAt: Date;
}

export type WindowStatus = 'PROCESSING' | 'COMPLETED';

export interface DispatchWindow {
  runDate: string;
  slot: number;
  status: WindowStatus;
  jobsDispatched: number;
  startedAt: Date;
  completedAt: Date | null;
}
