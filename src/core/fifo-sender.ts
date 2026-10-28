import { chunk, mapLimit } from '../common/concurrency.js';
import type { Logger } from '../common/telemetry.js';
import type { FifoMessage, FifoQueue } from './ports.js';

/**
 * Bulk send to the FIFO shared by the Dispatcher and the Reconciler (CLAUDE.md §6.1 step 5–6):
 * `SendMessageBatch` in chunks of 10, `SEND_CONCURRENCY` batches in flight, and up to
 * `SEND_RETRIES` retries of the entries that failed. Never throws: returns what still failed.
 */

export const SEND_CONCURRENCY = 10;
/** Retries of the failed entries of a `SendMessageBatch`, after the first try. */
export const SEND_RETRIES = 3;

export async function sendAll(
  queue: FifoQueue,
  messages: readonly FifoMessage[],
  logger: Logger,
  logMessage: string,
): Promise<FifoMessage[]> {
  const failed = await mapLimit(chunk(messages, 10), SEND_CONCURRENCY, (batch) =>
    sendBatch(queue, batch),
  );
  const stillFailed = failed.flatMap((f) => f.messages);
  if (stillFailed.length > 0) {
    logger.log('error', logMessage, {
      jobIds: stillFailed.map((m) => m.deduplicationId),
      error: failed.find((f) => f.error !== '')?.error,
    });
  }
  return stillFailed;
}

async function sendBatch(
  queue: FifoQueue,
  batch: readonly FifoMessage[],
): Promise<{ messages: FifoMessage[]; error: string }> {
  let pending: readonly FifoMessage[] = batch;
  let error = '';
  for (let attempt = 0; attempt <= SEND_RETRIES && pending.length > 0; attempt++) {
    let failedIndexes: number[];
    try {
      const result = await queue.sendBatch(pending);
      failedIndexes = result.failed.map((f) => f.index);
      error = result.failed[0]?.error ?? error;
    } catch (thrown) {
      failedIndexes = pending.map((_, i) => i);
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    const current = pending;
    pending = failedIndexes.map((i) => current[i] as FifoMessage);
  }
  return { messages: [...pending], error: pending.length > 0 ? error : '' };
}
