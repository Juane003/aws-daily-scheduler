import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../../src/adapters/memory/clock.js';
import { InMemoryFifoQueue } from '../../src/adapters/memory/fifo-queue.js';
import { InMemoryLogger } from '../../src/adapters/memory/logger.js';
import { InMemoryMetrics } from '../../src/adapters/memory/metrics.js';
import { InMemoryRepository } from '../../src/adapters/memory/repository.js';
import { defaults, type Config } from '../../src/common/config.js';
import { parseJobMessage, type JobMessage } from '../../src/common/message.js';
import type { Registry } from '../../src/core/model.js';
import { createReconcilerHandler } from '../../src/handlers/reconciler.js';

const day = '2026-03-01';
const at = (hhmm: string, date = day) => new Date(`${date}T${hhmm}:00Z`);
const key = (registryId: string, runDate = day) => ({ registryId, runDate });

const registry = (id: string, slot: number): Registry => ({
  id,
  providerId: `p${Number(id) % 2}`,
  endpoint: '/q',
  httpMethod: 'POST',
  body: {},
  slot,
  enabled: true,
});

function setup(now: Date, registries: Registry[], config: Partial<Config> = {}) {
  const clock = new VirtualClock(now);
  const repository = new InMemoryRepository();
  repository.putRegistries(registries);
  const queue = new InMemoryFifoQueue(clock, { visibilityTimeoutS: 180 });
  const logger = new InMemoryLogger();
  const metrics = new InMemoryMetrics();
  const reconcile = createReconcilerHandler({
    repository,
    queue,
    clock,
    logger,
    metrics,
    config: { ...defaults, ...config },
  });
  return { clock, repository, queue, logger, metrics, reconcile };
}

/** Inserts executions as the Dispatcher would have, at `enqueuedAt`. */
async function dispatched(
  repo: InMemoryRepository,
  ids: string[],
  enqueuedAt: Date,
  runDate = day,
) {
  await repo.insertExecutions(
    ids.map((id) => ({ ...key(id, runDate), providerId: `p${Number(id) % 2}` })),
    enqueuedAt,
  );
}

function sent(queue: InMemoryFifoQueue): JobMessage[] {
  return queue.peekBodies().map((body) => {
    const parsed = parseJobMessage(body);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.message;
  });
}

describe('Reconciler: stale IN_PROGRESS', () => {
  it('requeues stale rows with seq + 1 and the same attempt, and leaves the rest alone', async () => {
    const ids = ['1', '2', '3', '4'];
    const { repository, queue, reconcile } = setup(
      at('12:00'),
      ids.map((id) => registry(id, 0)),
    );
    await dispatched(repository, ids, at('00:00'));
    await repository.claimExecution(key('1'), at('11:50'), 360); // stale
    await repository.claimExecution(key('2'), at('11:58'), 360); // fresh
    await repository.claimExecution(key('3'), at('01:00'), 360);
    await repository.updateExecution(
      key('3'),
      { status: ['IN_PROGRESS'] },
      { status: 'SUCCEEDED' },
    );
    await repository.claimExecution(key('4'), at('01:00'), 360);
    await repository.updateExecution(
      key('4'),
      { status: ['IN_PROGRESS'] },
      { status: 'FAILED_EXHAUSTED' },
    );

    const summary = await reconcile();

    expect(summary).toMatchObject({ staleRequeued: 1, missingRequeued: 0, sendFailures: 0 });
    expect(sent(queue)).toEqual([
      {
        jobId: '1#2026-03-01',
        registryId: '1',
        providerId: 'p1',
        runDate: day,
        attempt: 1,
        seq: 1,
        firstEnqueuedAt: '2026-03-01T00:00:00.000Z',
        reason: 'RECONCILE',
      },
    ]);
    expect(await repository.getExecution(key('1'))).toMatchObject({
      status: 'RETRYING',
      attempt: 1,
      seq: 1,
    });
    expect((await repository.getExecution(key('2')))?.status).toBe('IN_PROGRESS');
    expect((await repository.getExecution(key('3')))?.status).toBe('SUCCEEDED');
    expect((await repository.getExecution(key('4')))?.status).toBe('FAILED_EXHAUSTED');
    // The requeued job can be claimed again.
    expect(await repository.claimExecution(key('1'), at('12:01'), 360)).toBeDefined();
  });

  it('keeps a stale row IN_PROGRESS when its send fails, and retries it on the next run', async () => {
    const { repository, queue, reconcile, metrics, clock } = setup(at('12:00'), [registry('1', 0)]);
    await dispatched(repository, ['1'], at('00:00'));
    await repository.claimExecution(key('1'), at('11:00'), 360);
    queue.failSend = () => true;

    expect(await reconcile()).toMatchObject({ staleRequeued: 0, sendFailures: 1 });
    expect((await repository.getExecution(key('1')))?.status).toBe('IN_PROGRESS');
    expect(metrics.total('ReconcileFailures')).toBe(1);

    queue.failSend = undefined;
    clock.advanceSeconds(3600);
    expect(await reconcile()).toMatchObject({ staleRequeued: 1, sendFailures: 0 });
    expect((await repository.getExecution(key('1')))?.status).toBe('RETRYING');
  });

  it('does not overwrite a Worker that claimed the job between the send and the update', async () => {
    const { repository, queue, reconcile } = setup(at('12:00'), [registry('1', 0)]);
    await dispatched(repository, ['1'], at('00:00'));
    await repository.claimExecution(key('1'), at('11:00'), 360);
    // The claim runs synchronously inside the send, i.e. before the Reconciler's update.
    queue.failSend = () => {
      void repository.claimExecution(key('1'), at('12:00'), 360);
      return false;
    };

    await reconcile();

    expect(await repository.getExecution(key('1'))).toMatchObject({
      status: 'IN_PROGRESS',
      startedAt: at('12:00'),
    });
  });
});

describe('Reconciler: missing executions', () => {
  it('enqueues registries of past slots with no execution, leaving recent slots to the Dispatcher', async () => {
    // 12:00 is slot 720: slots < 710 are reconciled.
    const { repository, queue, reconcile, logger } = setup(at('12:00'), [
      registry('1', 100),
      registry('2', 100),
      registry('3', 709),
      registry('4', 710),
      registry('5', 1000),
    ]);
    await dispatched(repository, ['2'], at('01:40'));

    const summary = await reconcile();

    expect(summary).toMatchObject({ missingRequeued: 2, runDates: [day] });
    expect(sent(queue).map((m) => `${m.jobId}/${m.reason ?? ''}/${m.seq}`)).toEqual([
      '1#2026-03-01/RECONCILE/0',
      '3#2026-03-01/RECONCILE/0',
    ]);
    expect(await repository.getExecution(key('1'))).toMatchObject({
      status: 'ENQUEUED',
      enqueuedAt: at('12:00'),
    });
    expect(await repository.getExecution(key('4'))).toBeUndefined();
    expect(logger.find('missing job enqueued')).toHaveLength(2);
  });

  it('covers the previous day during the expiry grace period only', async () => {
    // Slot 500 of the previous day is not in its tail: an earlier run of that day owned it.
    const registries = [registry('1', 1439), registry('2', 500)];
    const early = setup(at('01:00', '2026-03-02'), registries);
    expect(await early.reconcile()).toMatchObject({
      runDates: ['2026-03-01', '2026-03-02'],
      missingRequeued: 1,
    });
    expect(sent(early.queue)[0]?.runDate).toBe('2026-03-01');

    const late = setup(at('06:01', '2026-03-02'), registries);
    expect(await late.reconcile()).toMatchObject({ runDates: ['2026-03-02'], missingRequeued: 0 });
  });

  it('does nothing for today in the first minutes of the day', async () => {
    const { reconcile } = setup(at('00:05'), [registry('1', 0)], { expiryGraceH: 0 });
    expect(await reconcile()).toMatchObject({ runDates: [day], missingRequeued: 0 });
  });
});

describe('Reconciler: limits and reporting', () => {
  it('respects reconcileMaxRequeue per run, across stale and missing', async () => {
    const ids = ['1', '2', '3', '4', '5', '6'];
    const { repository, queue, reconcile, clock, logger } = setup(
      at('12:00'),
      ids.map((id) => registry(id, 0)),
      { reconcileMaxRequeue: 4 },
    );
    await dispatched(repository, ['1', '2'], at('00:00'));
    await repository.claimExecution(key('1'), at('11:00'), 360);
    await repository.claimExecution(key('2'), at('11:00'), 360);

    expect(await reconcile()).toMatchObject({
      staleRequeued: 2,
      missingRequeued: 2,
      limitReached: true,
    });
    expect(queue.stats().available).toBe(4);
    expect(logger.find('reconcile requeue limit reached')).toHaveLength(1);

    clock.advanceSeconds(3600);
    expect(await reconcile()).toMatchObject({ missingRequeued: 2, limitReached: false });
  });

  it('only reports executions ENQUEUED for longer than enqueuedStaleH', async () => {
    const { repository, queue, reconcile, metrics, logger } = setup(at('12:00'), [
      registry('1', 0),
      registry('2', 0),
    ]);
    await dispatched(repository, ['1'], at('08:59'));
    await dispatched(repository, ['2'], at('09:01'));

    expect(await reconcile()).toMatchObject({ enqueuedStale: 1, staleRequeued: 0 });
    expect(queue.stats().available).toBe(0);
    expect(metrics.total('EnqueuedStale')).toBe(1);
    expect(logger.find('jobs ENQUEUED for too long')[0]?.fields).toMatchObject({
      sample: ['1#2026-03-01'],
    });
  });

  it('publishes completion and per-status / per-provider counts', async () => {
    const ids = ['1', '2', '3', '4'];
    const { repository, reconcile, metrics } = setup(
      at('12:00'),
      ids.map((id) => registry(id, 0)),
    );
    await dispatched(repository, ids, at('11:00'));
    for (const [id, status] of [
      ['1', 'SUCCEEDED'],
      ['2', 'FAILED_NON_RETRYABLE'],
    ] as const) {
      await repository.claimExecution(key(id), at('11:59'), 360);
      await repository.updateExecution(key(id), { status: ['IN_PROGRESS'] }, { status });
    }

    expect((await reconcile()).completionPct).toBe(50);
    expect(metrics.values('DailyCompletionPct')).toEqual([50]);
    expect(metrics.values('ExecutionsByStatus', { status: 'ENQUEUED' })).toEqual([2]);
    expect(metrics.values('PendingByProvider', { provider: 'p1' })).toEqual([1]);
    expect(metrics.values('PendingByProvider', { provider: 'p0' })).toEqual([1]);
  });

  it('reports 100% when nothing was dispatched yet', async () => {
    const { reconcile } = setup(at('00:05'), [], { expiryGraceH: 0 });
    expect((await reconcile()).completionPct).toBe(100);
  });
});
