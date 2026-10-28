import { mapLimit } from '../../common/concurrency.js';
import type { Config } from '../../common/config.js';
import { parseJobMessage, toDeadLetterMessage, toFifoMessage } from '../../common/message.js';
import type { Logger, Metrics } from '../../common/telemetry.js';
import type { Clock, FifoQueue } from '../ports.js';

/**
 * Requeue (D7, CLAUDE.md §6.5). Consumes the standard `retry` queue once each message's
 * `DelaySeconds` elapsed and sends it back to the FIFO with `MessageDeduplicationId = jobId#seq`.
 * It does not touch the database: the Worker already wrote `RETRYING`.
 *
 * Partial failures are reported per message (`ReportBatchItemFailures`): only those return to
 * `retry`, and after `maxReceiveCount` they move to the `retry` DLQ.
 */

export interface RequeueDeps {
  queue: FifoQueue;
  deadLetterQueue: FifoQueue;
  clock: Clock;
  logger: Logger;
  metrics: Metrics;
  config: Pick<Config, 'providerShards'>;
}

export interface RequeueRecord {
  messageId: string;
  body: string;
}

/** The ESM response shape for `ReportBatchItemFailures`. */
export interface BatchResponse {
  batchItemFailures: { itemIdentifier: string }[];
}

export class Requeue {
  constructor(private readonly deps: RequeueDeps) {}

  async handleBatch(records: readonly RequeueRecord[]): Promise<BatchResponse> {
    const results = await mapLimit(records, 10, (record) => this.handleOne(record));
    return {
      batchItemFailures: records
        .filter((_, i) => !results[i])
        .map((r) => ({ itemIdentifier: r.messageId })),
    };
  }

  /** Returns whether the record was handled (sent, or dead-lettered as invalid). */
  private async handleOne(record: RequeueRecord): Promise<boolean> {
    const { queue, deadLetterQueue, clock, logger, metrics, config } = this.deps;
    const parsed = parseJobMessage(record.body);
    try {
      if (!parsed.ok) {
        await deadLetterQueue.send(
          toDeadLetterMessage(
            {
              reason: 'INVALID_MESSAGE',
              error: parsed.error,
              failedAt: clock.now().toISOString(),
              raw: record.body,
            },
            config.providerShards,
          ),
        );
        metrics.count('JobsFailed', { reason: 'INVALID_MESSAGE' });
        logger.log('error', 'invalid retry message sent to DLQ', { error: parsed.error });
        return true;
      }
      await queue.send(toFifoMessage(parsed.message, config.providerShards));
      metrics.count('JobsRequeued', { reason: parsed.message.reason ?? 'RETRY' });
      return true;
    } catch (error) {
      logger.log('error', 'requeue failed', {
        messageId: record.messageId,
        ...(parsed.ok ? { jobId: parsed.message.jobId, seq: parsed.message.seq } : {}),
        error,
      });
      return false;
    }
  }
}
