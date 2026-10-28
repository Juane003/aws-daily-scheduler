import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../../src/adapters/memory/clock.js';
import { InMemoryFifoQueue } from '../../src/adapters/memory/fifo-queue.js';
import { InMemoryLogger } from '../../src/adapters/memory/logger.js';
import { InMemoryMetrics } from '../../src/adapters/memory/metrics.js';
import { InMemoryRepository } from '../../src/adapters/memory/repository.js';
import { defaults, type Config } from '../../src/common/config.js';
import { parseJobMessage, type JobMessage } from '../../src/common/message.js';
import { Dispatcher, type SlotOutcome } from '../../src/core/dispatch/dispatcher.js';
import type { Registry } from '../../src/core/model.js';
import type { FifoQueue } from '../../src/core/ports.js';
import { createDispatcherHandler } from '../../src/handlers/dispatcher.js';

const registry = (id: string, slot: number, providerId = `p${Number(id) % 3}`): Registry => ({
  id,
  providerId,
  endpoint: '/q',
  httpMethod: 'POST',
  body: {},
  slot,
  enabled: true,
});

function setup(start: string, registries: Registry[], config: Partial<Config> = {}) {
  const clock = new VirtualClock(start);
  const repository = new InMemoryRepository();
  repository.putRegistries(registries);
  const queue = new InMemoryFifoQueue(clock, { visibilityTimeoutS: 180 });
  const logger = new InMemoryLogger();
  const metrics = new InMemoryMetrics();
  const deps = { repository, clock, logger, metrics, config: { ...defaults, ...config } };
  const dispatcher = new Dispatcher({ ...deps, queue });
  return { ...deps, queue, dispatcher };
}

/** Receives and deletes every message, returning the parsed bodies. */
function drain(queue: InMemoryFifoQueue): JobMessage[] {
  const out: JobMessage[] = [];
  for (let batch = queue.receive(10); batch.length > 0; batch = queue.receive(10)) {
    for (const m of batch) {
      const parsed = parseJobMessage(m.body);
      if (!parsed.ok) throw new Error(parsed.error);
      out.push(parsed.message);
      queue.delete(m.receiptHandle);
    }
  }
  return out;
}

const byKey = (outcomes: SlotOutcome[]) =>
  Object.fromEntries(outcomes.map((o) => [`${o.runDate}/${o.slot}`, o.status]));

describe('Dispatcher: current slot', () => {
  it('records ENQUEUED, sends one valid message per registry and completes the window', async () => {
    const { dispatcher, repository, queue, metrics } = setup('2026-03-01T00:10:30Z', [
      registry('1', 10),
      registry('2', 10),
      registry('3', 11),
    ]);

    const outcomes = await dispatcher.tick();

    expect(outcomes.at(-1)).toMatchObject({
      runDate: '2026-03-01',
      slot: 10,
      reason: 'DISPATCH',
      status: 'COMPLETED',
      inserted: 2,
      sent: 2,
    });
    const messages = drain(queue);
    expect(messages).toEqual([
      expect.objectContaining({ jobId: '1#2026-03-01', providerId: 'p1', attempt: 0, seq: 0 }),
      expect.objectContaining({ jobId: '2#2026-03-01', providerId: 'p2', reason: 'DISPATCH' }),
    ]);
    expect(await repository.getExecution({ registryId: '1', runDate: '2026-03-01' })).toMatchObject(
      { status: 'ENQUEUED', providerId: 'p1' },
    );
    expect(await repository.getDispatchWindow('2026-03-01', 10)).toMatchObject({
      status: 'COMPLETED',
      jobsDispatched: 2,
    });
    expect(metrics.total('JobsDispatched', { reason: 'DISPATCH' })).toBe(2);
  });

  it('pages through more than one page of registries', async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => registry(String(i + 1), 0));
    const { dispatcher, queue, repository } = setup('2026-03-01T00:00:00Z', rows);
    await dispatcher.tick();
    expect(queue.stats().available).toBe(2500);
    expect((await repository.getDispatchWindow('2026-03-01', 0))?.jobsDispatched).toBe(2500);
  });

  it('uses providerId#shard as the group when providerShards > 1', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => registry(String(i + 1), 0, 'hot'));
    const { dispatcher, queue } = setup('2026-03-01T00:00:00Z', rows, { providerShards: 4 });
    await dispatcher.tick();
    const groups = new Set(queue.receive(10).map((m) => m.groupId));
    expect([...groups].every((g) => /^hot#[0-3]$/.test(g ?? ''))).toBe(true);
    expect(groups.size).toBeGreaterThan(1);
  });
});

describe('Dispatcher: no double dispatch', () => {
  it('skips a window that is already COMPLETED (duplicate tick)', async () => {
    const { dispatcher, queue } = setup('2026-03-01T00:10:00Z', [registry('1', 10)]);
    await dispatcher.tick();
    const second = await dispatcher.tick();
    expect(second.at(-1)).toMatchObject({ status: 'SKIPPED', sent: 0 });
    expect(queue.stats().available).toBe(1);
  });

  it('does not re-enqueue a registry that already has an execution for the day', async () => {
    const { dispatcher, repository, queue } = setup('2026-03-01T00:10:00Z', [
      registry('1', 10),
      registry('2', 10),
    ]);
    await repository.insertExecutions(
      [{ registryId: '1', runDate: '2026-03-01', providerId: 'p1' }],
      new Date('2026-03-01T00:00:00Z'),
    );
    const outcomes = await dispatcher.tick();
    expect(outcomes.at(-1)).toMatchObject({ inserted: 1, sent: 1 });
    expect(drain(queue).map((m) => m.registryId)).toEqual(['2']);
  });
});

describe('Dispatcher: lookback', () => {
  it('crosses midnight, using the previous run date for the previous day slots', async () => {
    const { dispatcher, repository, queue } = setup('2026-03-02T00:02:15Z', [
      registry('1', 1436), // outside the lookback (1437..1439, 0, 1)
      registry('2', 1437),
      registry('3', 1439),
      registry('4', 1),
      registry('5', 2),
    ]);

    const outcomes = await dispatcher.tick();

    expect(outcomes.map((o) => `${o.runDate}/${o.slot}/${o.reason}`)).toEqual([
      '2026-03-01/1437/LOOKBACK',
      '2026-03-01/1438/LOOKBACK',
      '2026-03-01/1439/LOOKBACK',
      '2026-03-02/0/LOOKBACK',
      '2026-03-02/1/LOOKBACK',
      '2026-03-02/2/DISPATCH',
    ]);
    expect(outcomes.every((o) => o.status === 'COMPLETED')).toBe(true);
    expect(
      drain(queue)
        .map((m) => `${m.jobId}/${m.reason ?? ''}`)
        .sort(),
    ).toEqual([
      '2#2026-03-01/LOOKBACK',
      '3#2026-03-01/LOOKBACK',
      '4#2026-03-02/LOOKBACK',
      '5#2026-03-02/DISPATCH',
    ]);
    expect(await repository.getExecution({ registryId: '1', runDate: '2026-03-01' })).toBe(
      undefined,
    );
  });

  it('only revisits windows that are not COMPLETED', async () => {
    const { dispatcher, clock } = setup('2026-03-01T00:10:00Z', []);
    await dispatcher.tick();
    clock.advanceSeconds(60);
    const outcomes = await dispatcher.tick();
    expect(byKey(outcomes)).toEqual({
      '2026-03-01/6': 'SKIPPED',
      '2026-03-01/7': 'SKIPPED',
      '2026-03-01/8': 'SKIPPED',
      '2026-03-01/9': 'SKIPPED',
      '2026-03-01/10': 'SKIPPED',
      '2026-03-01/11': 'COMPLETED',
    });
  });

  it('works with a business time zone other than UTC', async () => {
    // 01:30 UTC is 22:30 of the previous day in Buenos Aires (UTC-3, no DST).
    const { dispatcher } = setup('2026-03-02T01:30:00Z', [], {
      businessTz: 'America/Argentina/Buenos_Aires',
      lookbackSlots: 0,
    });
    expect(await dispatcher.tick()).toEqual([
      expect.objectContaining({ runDate: '2026-03-01', slot: 1350 }),
    ]);
  });
});

describe('Dispatcher: send failures', () => {
  it('retries failed batch entries and completes when a retry succeeds', async () => {
    const { dispatcher, queue } = setup('2026-03-01T00:10:00Z', [
      registry('1', 10),
      registry('2', 10),
    ]);
    let failures = 0;
    queue.failSend = (m) => m.deduplicationId.startsWith('2#') && failures++ < 3;
    const outcomes = await dispatcher.tick();
    expect(outcomes.at(-1)).toMatchObject({ status: 'COMPLETED', sent: 2, failed: 0 });
  });

  it('leaves the window PROCESSING after a partial batch failure, and the lookback recovers it', async () => {
    const { dispatcher, queue, clock, metrics, logger, repository } = setup(
      '2026-03-01T00:10:00Z',
      [registry('1', 10), registry('2', 10), registry('3', 10)],
    );
    queue.failSend = (m) => m.deduplicationId.startsWith('2#');

    const first = await dispatcher.tick();
    expect(first.at(-1)).toMatchObject({ status: 'PROCESSING', inserted: 3, sent: 2, failed: 1 });
    expect((await repository.getDispatchWindow('2026-03-01', 10))?.status).toBe('PROCESSING');
    expect(metrics.total('DispatchFailures')).toBe(1);
    expect(logger.find('dispatch send failed')[0]?.fields).toMatchObject({
      jobIds: ['2#2026-03-01#0'],
    });
    // The row exists although the message was not sent.
    expect(
      (await repository.getExecution({ registryId: '2', runDate: '2026-03-01' }))?.status,
    ).toBe('ENQUEUED');

    queue.failSend = undefined;
    clock.advanceSeconds(60);
    const second = await dispatcher.tick();
    expect(second.find((o) => o.slot === 10)).toMatchObject({
      reason: 'LOOKBACK',
      status: 'COMPLETED',
      inserted: 0,
    });
    // Re-sent rows 1 and 3 are dropped by FIFO deduplication: each job is queued exactly once.
    expect(
      drain(queue)
        .map((m) => m.registryId)
        .sort(),
    ).toEqual(['1', '2', '3']);
    expect((await repository.getDispatchWindow('2026-03-01', 10))?.jobsDispatched).toBe(3);
  });

  it('treats a rejected SendMessageBatch as a failure of every entry', async () => {
    const clock = new VirtualClock('2026-03-01T00:10:00Z');
    const repository = new InMemoryRepository();
    repository.putRegistries([registry('1', 10)]);
    let calls = 0;
    const queue: FifoQueue = {
      send: () => Promise.resolve(),
      sendBatch: () => {
        calls++;
        return Promise.reject(new Error('network down'));
      },
    };
    const logger = new InMemoryLogger();
    const dispatcher = new Dispatcher({
      repository,
      queue,
      clock,
      logger,
      metrics: new InMemoryMetrics(),
      config: { ...defaults, lookbackSlots: 0 },
    });
    expect(await dispatcher.tick()).toEqual([
      expect.objectContaining({ status: 'PROCESSING', failed: 1 }),
    ]);
    expect(calls).toBe(4);
    expect(logger.find('dispatch send failed')[0]?.fields).toMatchObject({ error: 'network down' });
  });

  it('keeps going when the database fails for one window', async () => {
    class FlakyRepository extends InMemoryRepository {
      override listRegistriesBySlot(slot: number, after: string | null, limit: number) {
        if (slot === 8) return Promise.reject(new Error('connection reset'));
        return super.listRegistriesBySlot(slot, after, limit);
      }
    }
    const clock = new VirtualClock('2026-03-01T00:10:00Z');
    const repository = new FlakyRepository();
    repository.putRegistries([registry('1', 10)]);
    const metrics = new InMemoryMetrics();
    const handler = createDispatcherHandler({
      repository,
      queue: new InMemoryFifoQueue(clock, { visibilityTimeoutS: 180 }),
      clock,
      logger: new InMemoryLogger(),
      metrics,
      config: defaults,
    });

    const outcomes = await handler();

    expect(outcomes.find((o) => o.slot === 8)).toMatchObject({
      status: 'PROCESSING',
      error: 'connection reset',
    });
    expect(outcomes.at(-1)).toMatchObject({ slot: 10, status: 'COMPLETED', sent: 1 });
    expect(metrics.total('DispatchFailures')).toBe(1);
    expect((await repository.getDispatchWindow('2026-03-01', 8))?.status).toBe('PROCESSING');
  });
});
