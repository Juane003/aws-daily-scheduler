import type { Config } from '../../common/config.js';
import { jobIdOf, newJobMessage, toFifoMessage, type JobMessage } from '../../common/message.js';
import { SLOTS_PER_DAY } from '../../common/slot.js';
import type { Logger, Metrics } from '../../common/telemetry.js';
import { addDays, businessDate, endOfBusinessDay, minuteOfDay } from '../../common/time.js';
import { sendAll } from '../fifo-sender.js';
import { EXECUTION_STATUSES, isTerminal, type Execution } from '../model.js';
import type {
  Clock,
  ExecutionRepository,
  ExecutionStats,
  FifoMessage,
  FifoQueue,
  RegistryRepository,
  SlotCursor,
} from '../ports.js';

/**
 * Reconciler (D10, CLAUDE.md §6.6). Runs every hour as the same-day safety net:
 *
 * 1. **Stale:** `IN_PROGRESS` rows whose Worker died (`started_at < now - staleAfterS`) are sent
 *    back to the FIFO with `seq + 1` and the same `attempt` (the claim already counted it), then
 *    marked `RETRYING`.
 * 2. **Missing:** registries of slots already past (`slot < current - 10`) with no execution for
 *    the day are inserted as `ENQUEUED` and sent with `reason = RECONCILE`.
 * 3. **Old `ENQUEUED`:** only reported. Waiting may be legitimate (provider backlog).
 * 4. Publishes completion and per-status / per-provider counts.
 *
 * Both requeue steps share `reconcileMaxRequeue` per run, so a big incident cannot flood the FIFO.
 * The previous business day is included while its jobs can still run (`expiryGraceH`), so misses
 * just before midnight are covered too.
 */

export const RECONCILE_PAGE_SIZE = 1000;
/** Slots this close to the current minute are left to the Dispatcher and its lookback. */
export const MISSING_SLOT_MARGIN = 10;

export type ReconcileConfig = Pick<
  Config,
  | 'businessTz'
  | 'providerShards'
  | 'staleAfterS'
  | 'expiryGraceH'
  | 'enqueuedStaleH'
  | 'reconcileMaxRequeue'
>;

export interface ReconcilerDeps {
  repository: RegistryRepository & ExecutionRepository;
  queue: FifoQueue;
  clock: Clock;
  logger: Logger;
  metrics: Metrics;
  config: ReconcileConfig;
}

export interface ReconcileSummary {
  runDates: string[];
  staleRequeued: number;
  missingRequeued: number;
  sendFailures: number;
  enqueuedStale: number;
  limitReached: boolean;
  completionPct: number;
}

export class Reconciler {
  constructor(private readonly deps: ReconcilerDeps) {}

  async run(): Promise<ReconcileSummary> {
    const { clock, config, logger } = this.deps;
    const now = clock.now();
    const today = businessDate(now, config.businessTz);
    const yesterday = addDays(today, -1);
    const graceEnd =
      endOfBusinessDay(yesterday, config.businessTz).getTime() + config.expiryGraceH * 3_600_000;
    // [runDate, slots below which a registry should already have an execution]
    const days: [string, number][] = [];
    if (now.getTime() <= graceEnd) days.push([yesterday, SLOTS_PER_DAY]);
    days.push([today, minuteOfDay(now, config.businessTz) - MISSING_SLOT_MARGIN]);

    const budget = { remaining: config.reconcileMaxRequeue };
    const summary: ReconcileSummary = {
      runDates: days.map(([d]) => d),
      staleRequeued: 0,
      missingRequeued: 0,
      sendFailures: 0,
      enqueuedStale: 0,
      limitReached: false,
      completionPct: 100,
    };

    for (const [runDate] of days) {
      const stale = await this.requeueStale(runDate, now, budget);
      summary.staleRequeued += stale.sent;
      summary.sendFailures += stale.failed;
    }
    for (const [runDate, slotBefore] of days) {
      const missing = await this.requeueMissing(runDate, slotBefore, now, budget);
      summary.missingRequeued += missing.sent;
      summary.sendFailures += missing.failed;
    }
    for (const [runDate] of days) {
      summary.enqueuedStale += await this.reportOldEnqueued(runDate, now);
    }
    summary.limitReached = budget.remaining <= 0;
    summary.completionPct = this.publishStats(
      today,
      await this.deps.repository.executionStats(today),
    );

    if (summary.sendFailures > 0) {
      this.deps.metrics.count('ReconcileFailures', {}, summary.sendFailures);
    }
    if (summary.limitReached) {
      logger.log('warn', 'reconcile requeue limit reached', { limit: config.reconcileMaxRequeue });
    }
    logger.log('info', 'reconcile completed', { ...summary });
    return summary;
  }

  private async requeueStale(
    runDate: string,
    now: Date,
    budget: { remaining: number },
  ): Promise<{ sent: number; failed: number }> {
    const { repository, config, logger } = this.deps;
    const startedBefore = new Date(now.getTime() - config.staleAfterS * 1000);
    let sent = 0;
    let failed = 0;
    for (let after: string | undefined; budget.remaining > 0;) {
      const rows = await repository.findExecutions({
        runDate,
        status: 'IN_PROGRESS',
        startedBefore,
        limit: Math.min(RECONCILE_PAGE_SIZE, budget.remaining),
        ...(after === undefined ? {} : { after }),
      });
      const last = rows.at(-1);
      if (last === undefined) break;
      after = last.registryId;
      budget.remaining -= rows.length;

      const messages = new Map(rows.map((row) => [row, staleMessage(row)]));
      // Send first, then mark RETRYING: if the send fails the row stays IN_PROGRESS and stale, so
      // the next run picks it up again. The update is fenced by started_at, so a Worker that
      // claimed the job in between is not overwritten.
      const unsent = await this.send([...messages.values()], 'reconcile stale send failed');
      for (const [row, message] of messages) {
        if (unsent.has(message.jobId)) continue;
        await repository.updateExecution(
          row,
          {
            status: ['IN_PROGRESS'],
            ...(row.startedAt === null ? {} : { startedAt: row.startedAt }),
          },
          { status: 'RETRYING', seq: message.seq, nextAttemptAt: now },
        );
        logger.log('info', 'stale job requeued', { ...logFields(message) });
      }
      sent += rows.length - unsent.size;
      failed += unsent.size;
    }
    return { sent, failed };
  }

  private async requeueMissing(
    runDate: string,
    slotBefore: number,
    now: Date,
    budget: { remaining: number },
  ): Promise<{ sent: number; failed: number }> {
    const { repository, logger } = this.deps;
    let sent = 0;
    let failed = 0;
    for (let after: SlotCursor | null = null; slotBefore > 0 && budget.remaining > 0;) {
      const page = await repository.findRegistriesWithoutExecution(
        runDate,
        slotBefore,
        after,
        Math.min(RECONCILE_PAGE_SIZE, budget.remaining),
      );
      const last = page.at(-1);
      if (last === undefined) break;
      after = { slot: last.slot, id: last.id };

      const inserted = new Set(
        await repository.insertExecutions(
          page.map((r) => ({ registryId: r.id, runDate, providerId: r.providerId })),
          now,
        ),
      );
      budget.remaining -= inserted.size;
      const messages = page
        .filter((r) => inserted.has(r.id))
        .map((r) => newJobMessage(r.id, r.providerId, runDate, 'RECONCILE', now));
      const unsent = await this.send(messages, 'reconcile missing send failed');
      for (const m of messages) {
        if (!unsent.has(m.jobId)) logger.log('info', 'missing job enqueued', logFields(m));
      }
      sent += messages.length - unsent.size;
      failed += unsent.size;
    }
    return { sent, failed };
  }

  private async reportOldEnqueued(runDate: string, now: Date): Promise<number> {
    const { repository, config, logger, metrics } = this.deps;
    const enqueuedBefore = new Date(now.getTime() - config.enqueuedStaleH * 3_600_000);
    let count = 0;
    const sample: string[] = [];
    for (let after: string | undefined; ;) {
      const rows = await repository.findExecutions({
        runDate,
        status: 'ENQUEUED',
        enqueuedBefore,
        limit: RECONCILE_PAGE_SIZE,
        ...(after === undefined ? {} : { after }),
      });
      const last = rows.at(-1);
      if (last === undefined) break;
      after = last.registryId;
      count += rows.length;
      for (const row of rows.slice(0, 10 - sample.length)) {
        sample.push(jobIdOf(row.registryId, row.runDate));
      }
    }
    if (count > 0) {
      metrics.count('EnqueuedStale', { runDate }, count);
      logger.log('warn', 'jobs ENQUEUED for too long', { runDate, count, sample });
    }
    return count;
  }

  /** Returns the jobIds that could not be sent. */
  private async send(messages: readonly JobMessage[], logMessage: string): Promise<Set<string>> {
    const { queue, logger, config } = this.deps;
    const byDedup = new Map<string, JobMessage>();
    const fifo: FifoMessage[] = messages.map((m) => {
      const out = toFifoMessage(m, config.providerShards);
      byDedup.set(out.deduplicationId, m);
      return out;
    });
    const failed = await sendAll(queue, fifo, logger, logMessage);
    return new Set(failed.map((f) => byDedup.get(f.deduplicationId)?.jobId ?? ''));
  }

  /** `DailyCompletionPct`: terminal executions over executions created so far today. */
  private publishStats(runDate: string, stats: ExecutionStats): number {
    const { metrics, logger } = this.deps;
    const terminal = EXECUTION_STATUSES.filter(isTerminal).reduce(
      (sum, s) => sum + stats.byStatus[s],
      0,
    );
    const pct = stats.total === 0 ? 100 : (100 * terminal) / stats.total;
    metrics.record('DailyCompletionPct', pct, { runDate });
    for (const status of EXECUTION_STATUSES) {
      metrics.record('ExecutionsByStatus', stats.byStatus[status], { runDate, status });
    }
    // Per provider only the backlog (non-terminal), to keep the metric cardinality useful.
    for (const [provider, counts] of Object.entries(stats.byProvider)) {
      const pending = EXECUTION_STATUSES.filter((s) => !isTerminal(s)).reduce(
        (sum, s) => sum + (counts[s] ?? 0),
        0,
      );
      if (pending > 0) metrics.record('PendingByProvider', pending, { runDate, provider });
    }
    logger.log('info', 'daily execution stats', { runDate, ...stats, completionPct: pct });
    return pct;
  }
}

function staleMessage(row: Execution): JobMessage {
  return {
    jobId: jobIdOf(row.registryId, row.runDate),
    registryId: row.registryId,
    providerId: row.providerId,
    runDate: row.runDate,
    attempt: row.attempt,
    seq: row.seq + 1,
    firstEnqueuedAt: row.enqueuedAt.toISOString(),
    reason: 'RECONCILE',
  };
}

function logFields(m: JobMessage) {
  return {
    jobId: m.jobId,
    providerId: m.providerId,
    runDate: m.runDate,
    attempt: m.attempt,
    seq: m.seq,
    reason: m.reason,
  };
}
