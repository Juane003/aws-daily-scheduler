import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Job message contract (CLAUDE.md §5), shared by the FIFO, the `retry` queue and the DLQ.
 * Every consumer validates with {@link parseJobMessage}; an invalid message goes to the DLQ with
 * `reason = 'INVALID_MESSAGE'` and is never dropped silently.
 */

export const JOB_REASONS = ['DISPATCH', 'RETRY', 'CIRCUIT_DEFER', 'RECONCILE', 'LOOKBACK'] as const;
export type JobReason = (typeof JOB_REASONS)[number];

export const jobMessageSchema = z
  .object({
    jobId: z.string(),
    /** `registries.id` is a BIGINT; carried as a decimal string to avoid precision loss. */
    registryId: z.string().regex(/^\d+$/, 'registryId must be a decimal BIGINT'),
    providerId: z.string().min(1),
    runDate: z.iso.date(),
    /** Real calls already made to the API; breaker defers do not count. */
    attempt: z.int().nonnegative(),
    /** Re-enqueues so far (defers included); part of the deduplication id. */
    seq: z.int().nonnegative(),
    firstEnqueuedAt: z.iso.datetime(),
    reason: z.enum(JOB_REASONS).optional(),
  })
  .refine((m) => m.jobId === jobIdOf(m.registryId, m.runDate), {
    message: 'jobId must be `${registryId}#${runDate}`',
    path: ['jobId'],
  });

export type JobMessage = z.infer<typeof jobMessageSchema>;

export type ParseResult =
  { ok: true; message: JobMessage } | { ok: false; reason: 'INVALID_MESSAGE'; error: string };

/** Accepts the raw SQS body (a JSON string) or an already-parsed value. */
export function parseJobMessage(raw: unknown): ParseResult {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch (error) {
      return { ok: false, reason: 'INVALID_MESSAGE', error: `invalid JSON: ${String(error)}` };
    }
  }
  const parsed = jobMessageSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, reason: 'INVALID_MESSAGE', error: z.prettifyError(parsed.error) };
  }
  return { ok: true, message: parsed.data };
}

/** D12: deterministic job id, one per registry and business day. */
export function jobIdOf(registryId: string, runDate: string): string {
  return `${registryId}#${runDate}`;
}

/** FIFO `MessageDeduplicationId`: a new `seq` is a new message, a resend of the same one is not. */
export function deduplicationId(message: Pick<JobMessage, 'jobId' | 'seq'>): string {
  return `${message.jobId}#${message.seq}`;
}

/**
 * FIFO `MessageGroupId` (D5): `providerId` when `shards = 1`, otherwise `providerId#shard` with a
 * stable shard per registry. The shard uses sha256 bytes 4..8, not 0..4 like the slot, so the
 * shard does not correlate with the slot (e.g. `k = 2` would otherwise follow slot parity).
 */
export function groupId(providerId: string, registryId: string, shards: number): string {
  if (!Number.isInteger(shards) || shards < 1) {
    throw new RangeError(`shards must be a positive integer, got ${shards}`);
  }
  if (shards === 1) return providerId;
  const digest = createHash('sha256').update(registryId, 'utf8').digest();
  return `${providerId}#${digest.readUInt32BE(4) % shards}`;
}

/**
 * Builds the message for the next enqueue of the same job (`retry`, breaker defer, reconcile):
 * `seq + 1` always, `attempt` only changes when a real call was made.
 */
export function nextMessage(
  message: JobMessage,
  reason: JobReason,
  attempt: number = message.attempt,
): JobMessage {
  return { ...message, attempt, seq: message.seq + 1, reason };
}

/** First message of a job (Dispatcher, or Reconciler for a missing one): no attempts, `seq = 0`. */
export function newJobMessage(
  registryId: string,
  providerId: string,
  runDate: string,
  reason: JobReason,
  now: Date,
): JobMessage {
  return {
    jobId: jobIdOf(registryId, runDate),
    registryId,
    providerId,
    runDate,
    attempt: 0,
    seq: 0,
    firstEnqueuedAt: now.toISOString(),
    reason,
  };
}

/** The FIFO send request for `message`: body plus group and deduplication ids. */
export function toFifoMessage(
  message: JobMessage,
  shards: number,
): { body: string; groupId: string; deduplicationId: string } {
  return {
    body: JSON.stringify(message),
    groupId: groupId(message.providerId, message.registryId, shards),
    deduplicationId: deduplicationId(message),
  };
}

export const DEAD_LETTER_REASONS = [
  'INVALID_MESSAGE',
  'NON_RETRYABLE',
  'EXHAUSTED',
  'EXPIRED',
] as const;
export type DeadLetterReason = (typeof DEAD_LETTER_REASONS)[number];

/**
 * Body of a message the Worker sends to the DLQ: the job plus why it is there. Poison messages
 * moved by the SQS redrive policy arrive as a bare {@link JobMessage} instead; the redrive tooling
 * accepts both.
 */
export interface DeadLetter {
  reason: DeadLetterReason;
  error?: string;
  failedAt: string;
  message?: JobMessage;
  /** The original body, when it could not be parsed. */
  raw?: string;
}

/** FIFO send request for a dead letter. Invalid messages share one group, keyed by body hash. */
export function toDeadLetterMessage(
  letter: DeadLetter,
  shards: number,
): { body: string; groupId: string; deduplicationId: string } {
  const body = JSON.stringify(letter);
  if (letter.message === undefined) {
    const digest = createHash('sha256')
      .update(letter.raw ?? body, 'utf8')
      .digest('hex');
    return { body, groupId: 'INVALID_MESSAGE', deduplicationId: digest };
  }
  return {
    body,
    groupId: groupId(letter.message.providerId, letter.message.registryId, shards),
    deduplicationId: deduplicationId(letter.message),
  };
}
