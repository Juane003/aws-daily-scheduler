import type { Config } from '../../common/config.js';
import { newJobMessage, toFifoMessage } from '../../common/message.js';
import { SLOTS_PER_DAY } from '../../common/slot.js';
import type { Logger, Metrics } from '../../common/telemetry.js';
import { addDays, businessDate, minuteOfDay } from '../../common/time.js';
import { sendAll } from '../fifo-sender.js';
import type { Registry } from '../model.js';
import type {
  Clock,
  DispatchWindowRepository,
  ExecutionRepository,
  FifoQueue,
  RegistryRepository,
} from '../ports.js';

/**
 * Dispatcher (D2–D4, CLAUDE.md §6.1). Runs once per minute: dispatches the slot of the current
 * minute and any of the previous `lookbackSlots` windows that is not `COMPLETED` (a missed tick or
 * a run that failed half-way). Each job is recorded as `ENQUEUED` before it is sent, and only rows
 * this run inserted are sent, so a duplicate tick never enqueues a job twice.
 */

export const DISPATCH_PAGE_SIZE = 1000;

export type DispatchConfig = Pick<Config, 'businessTz' | 'lookbackSlots' | 'providerShards'>;

export interface DispatcherDeps {
  repository: RegistryRepository & ExecutionRepository & DispatchWindowRepository;
  queue: FifoQueue;
  clock: Clock;
  logger: Logger;
  metrics: Metrics;
  config: DispatchConfig;
}

export type DispatchReason = 'DISPATCH' | 'LOOKBACK';

export interface SlotOutcome {
  runDate: string;
  slot: number;
  reason: DispatchReason;
  /** `SKIPPED`: already `COMPLETED`. `PROCESSING`: something failed; the lookback retries it. */
  status: 'COMPLETED' | 'PROCESSING' | 'SKIPPED';
  /** Enabled registries of the slot; each has an execution for the day once its page is done. */
  jobs: number;
  inserted: number;
  sent: number;
  failed: number;
  error?: string;
}

export class Dispatcher {
  constructor(private readonly deps: DispatcherDeps) {}

  /** One scheduler tick. Never throws: a failed window stays `PROCESSING` for the next tick. */
  async tick(): Promise<SlotOutcome[]> {
    const { clock, config } = this.deps;
    const now = clock.now();
    const today = businessDate(now, config.businessTz);
    const current = minuteOfDay(now, config.businessTz);

    const outcomes: SlotOutcome[] = [];
    for (let back = config.lookbackSlots; back >= 1; back--) {
      const slot = current - back;
      outcomes.push(
        slot >= 0
          ? await this.dispatchSlot(today, slot, 'LOOKBACK')
          : await this.dispatchSlot(addDays(today, -1), slot + SLOTS_PER_DAY, 'LOOKBACK'),
      );
    }
    outcomes.push(await this.dispatchSlot(today, current, 'DISPATCH'));
    return outcomes;
  }

  async dispatchSlot(runDate: string, slot: number, reason: DispatchReason): Promise<SlotOutcome> {
    const { repository, clock, logger, metrics } = this.deps;
    const outcome: SlotOutcome = {
      runDate,
      slot,
      reason,
      status: 'PROCESSING',
      jobs: 0,
      inserted: 0,
      sent: 0,
      failed: 0,
    };
    try {
      const window = await repository.getDispatchWindow(runDate, slot);
      if (window?.status === 'COMPLETED') return { ...outcome, status: 'SKIPPED' };
      // A PROCESSING row means an earlier run inserted jobs it may not have sent.
      const recovering = window !== undefined;
      await repository.beginDispatchWindow(runDate, slot, clock.now());

      for (let after: string | null = null; ;) {
        const page: Registry[] = await repository.listRegistriesBySlot(
          slot,
          after,
          DISPATCH_PAGE_SIZE,
        );
        const last = page.at(-1);
        if (last === undefined) break;
        after = last.id;

        const result = await this.dispatchPage(runDate, page, reason, recovering);
        outcome.jobs += page.length;
        outcome.inserted += result.inserted;
        outcome.sent += result.sent;
        outcome.failed += result.failed;
        if (page.length < DISPATCH_PAGE_SIZE) break;
      }

      if (outcome.sent > 0) metrics.count('JobsDispatched', { reason }, outcome.sent);
      if (outcome.failed > 0) {
        metrics.count('DispatchFailures', {}, outcome.failed);
        logger.log('error', 'dispatch window left in PROCESSING', { ...outcome });
        return outcome;
      }
      await repository.completeDispatchWindow(runDate, slot, outcome.jobs, clock.now());
      logger.log('info', 'dispatch window completed', { ...outcome, status: 'COMPLETED' });
      return { ...outcome, status: 'COMPLETED' };
    } catch (error) {
      metrics.count('DispatchFailures');
      logger.log('error', 'dispatch window failed', { ...outcome, error });
      return { ...outcome, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async dispatchPage(
    runDate: string,
    page: readonly Registry[],
    reason: DispatchReason,
    recovering: boolean,
  ): Promise<{ inserted: number; sent: number; failed: number }> {
    const { repository, clock, config } = this.deps;
    const now = clock.now();
    const inserted = await repository.insertExecutions(
      page.map((r) => ({ registryId: r.id, runDate, providerId: r.providerId })),
      now,
    );
    // Normally only the rows inserted now. When recovering, every row still ENQUEUED: FIFO dedup
    // drops what was already sent within 5 minutes, and the Worker claim drops anything older.
    const toSend = new Set(
      recovering
        ? (
            await repository.findEnqueuedExecutions(
              runDate,
              page.map((r) => r.id),
            )
          ).map((e) => e.registryId)
        : inserted,
    );
    const messages = page
      .filter((r) => toSend.has(r.id))
      .map((r) =>
        toFifoMessage(
          newJobMessage(r.id, r.providerId, runDate, reason, now),
          config.providerShards,
        ),
      );
    const failed = await sendAll(
      this.deps.queue,
      messages,
      this.deps.logger,
      'dispatch send failed',
    );
    return {
      inserted: inserted.length,
      sent: messages.length - failed.length,
      failed: failed.length,
    };
  }
}
