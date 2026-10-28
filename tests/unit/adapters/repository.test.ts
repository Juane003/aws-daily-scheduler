import { describe, expect, it } from 'vitest';
import { InMemoryRepository, compareIds } from '../../../src/adapters/memory/repository.js';
import { initialCircuit, transition } from '../../../src/common/circuit-breaker.js';
import { defaults } from '../../../src/common/config.js';
import type { Registry } from '../../../src/core/model.js';

const t0 = new Date('2026-03-01T12:00:00Z');
const at = (seconds: number): Date => new Date(t0.getTime() + seconds * 1000);
const day = '2026-03-01';
const key = (registryId: string) => ({ registryId, runDate: day });

const registry = (id: string, slot: number, enabled = true): Registry => ({
  id,
  providerId: `p${Number(id) % 2}`,
  endpoint: '/q',
  httpMethod: 'POST',
  body: {},
  slot,
  enabled,
});

async function withExecution(id = '1') {
  const repo = new InMemoryRepository();
  await repo.insertExecutions([{ ...key(id), providerId: 'p1' }], t0);
  return repo;
}

describe('InMemoryRepository: registries', () => {
  it('pages a slot by id as BIGINT, skipping disabled rows', async () => {
    const repo = new InMemoryRepository();
    repo.putRegistries([
      registry('10', 7),
      registry('9', 7),
      registry('100', 7),
      registry('2', 7, false),
      registry('3', 8),
    ]);

    const page1 = await repo.listRegistriesBySlot(7, null, 2);
    expect(page1.map((r) => r.id)).toEqual(['9', '10']);
    const page2 = await repo.listRegistriesBySlot(7, '10', 2);
    expect(page2.map((r) => r.id)).toEqual(['100']);
    expect(await repo.listRegistriesBySlot(7, '100', 2)).toEqual([]);
  });

  it('moves a registry when its slot changes', async () => {
    const repo = new InMemoryRepository();
    repo.putRegistries([registry('1', 5), registry('2', 5)]);
    repo.putRegistries([registry('1', 6)]);
    expect((await repo.listRegistriesBySlot(5, null, 10)).map((r) => r.id)).toEqual(['2']);
    expect((await repo.listRegistriesBySlot(6, null, 10)).map((r) => r.id)).toEqual(['1']);
  });

  it('rejects a slot outside 0..1439', () => {
    expect(() => {
      new InMemoryRepository().putRegistries([registry('1', 1440)]);
    }).toThrow(RangeError);
  });

  it('finds registries without an execution before a slot, with a (slot, id) cursor', async () => {
    const repo = new InMemoryRepository();
    repo.putRegistries([
      registry('1', 0),
      registry('2', 0),
      registry('3', 1),
      registry('4', 1, false),
      registry('5', 2),
      registry('6', 3),
    ]);
    await repo.insertExecutions([{ ...key('2'), providerId: 'p0' }], t0);

    const first = await repo.findRegistriesWithoutExecution(day, 3, null, 2);
    expect(first.map((r) => r.id)).toEqual(['1', '3']);
    const rest = await repo.findRegistriesWithoutExecution(day, 3, { slot: 1, id: '3' }, 10);
    expect(rest.map((r) => r.id)).toEqual(['5']);
    // Another day has no executions at all.
    const other = await repo.findRegistriesWithoutExecution('2026-03-02', 1, null, 10);
    expect(other.map((r) => r.id)).toEqual(['1', '2']);
  });

  it('returns copies', async () => {
    const repo = new InMemoryRepository();
    repo.putRegistries([registry('1', 0)]);
    const row = await repo.getRegistry('1');
    if (row) row.enabled = false;
    expect((await repo.getRegistry('1'))?.enabled).toBe(true);
  });
});

describe('InMemoryRepository: executions', () => {
  it('inserts ENQUEUED once per (registry, run_date) and returns only new ids', async () => {
    const repo = await withExecution('1');
    const inserted = await repo.insertExecutions(
      [
        { ...key('1'), providerId: 'p1' },
        { ...key('2'), providerId: 'p1' },
        { ...key('2'), providerId: 'p1' },
        { registryId: '1', runDate: '2026-03-02', providerId: 'p1' },
      ],
      at(10),
    );
    expect(inserted).toEqual(['2', '1']);
    expect(await repo.getExecution(key('1'))).toMatchObject({
      status: 'ENQUEUED',
      attempt: 0,
      seq: 0,
      enqueuedAt: t0,
    });
  });

  it('finds which of the given registries are still ENQUEUED', async () => {
    const repo = new InMemoryRepository();
    await repo.insertExecutions(
      ['1', '2', '3'].map((id) => ({ ...key(id), providerId: 'p1' })),
      t0,
    );
    await repo.claimExecution(key('2'), t0, 360);
    const rows = await repo.findEnqueuedExecutions(day, ['1', '2', '3', '4']);
    expect(rows.map((e) => e.registryId)).toEqual(['1', '3']);
  });

  it('claims ENQUEUED and RETRYING, counting the attempt', async () => {
    const repo = await withExecution();
    const claimed = await repo.claimExecution(key('1'), at(1), 360);
    expect(claimed).toMatchObject({ status: 'IN_PROGRESS', startedAt: at(1), attempt: 1 });

    await repo.updateExecution(key('1'), { status: ['IN_PROGRESS'] }, { status: 'RETRYING' });
    expect((await repo.claimExecution(key('1'), at(2), 360))?.attempt).toBe(2);
  });

  it('does not claim a fresh IN_PROGRESS or a terminal row, but re-claims a stale one', async () => {
    const repo = await withExecution();
    await repo.claimExecution(key('1'), t0, 360);
    expect(await repo.claimExecution(key('1'), at(360), 360)).toBeUndefined();
    expect(await repo.claimExecution(key('1'), at(361), 360)).toMatchObject({
      startedAt: at(361),
      attempt: 2,
    });

    await repo.updateExecution(key('1'), { status: ['IN_PROGRESS'] }, { status: 'SUCCEEDED' });
    expect(await repo.claimExecution(key('1'), at(10_000), 360)).toBeUndefined();
    expect(await repo.claimExecution(key('missing'), t0, 360)).toBeUndefined();
  });

  it('lets only one of two concurrent claims win', async () => {
    const repo = await withExecution();
    const [a, b] = await Promise.all([
      repo.claimExecution(key('1'), t0, 360),
      repo.claimExecution(key('1'), t0, 360),
    ]);
    expect([a, b].filter((c) => c !== undefined)).toHaveLength(1);
  });

  it('applies conditional updates only when status and fencing token match', async () => {
    const repo = await withExecution();
    await repo.claimExecution(key('1'), at(5), 360);

    expect(
      await repo.updateExecution(key('1'), { status: ['ENQUEUED'] }, { status: 'RETRYING' }),
    ).toBe(false);
    expect(
      await repo.updateExecution(
        key('1'),
        { status: ['IN_PROGRESS'], startedAt: at(4) },
        { status: 'RETRYING' },
      ),
    ).toBe(false);
    expect(
      await repo.updateExecution(
        key('1'),
        { status: ['IN_PROGRESS'], startedBefore: at(5) },
        { status: 'RETRYING' },
      ),
    ).toBe(false);
    expect(
      await repo.updateExecution(
        key('1'),
        { status: ['IN_PROGRESS'], startedAt: at(5), startedBefore: at(6) },
        { status: 'RETRYING', seq: 1, nextAttemptAt: at(60), lastHttpStatus: 503 },
      ),
    ).toBe(true);
    expect(await repo.getExecution(key('1'))).toMatchObject({
      status: 'RETRYING',
      seq: 1,
      nextAttemptAt: at(60),
      lastHttpStatus: 503,
    });
    expect(await repo.updateExecution(key('nope'), { status: ['RETRYING'] }, {})).toBe(false);
  });

  it('writes the result and SUCCEEDED atomically, only if the condition holds', async () => {
    const repo = await withExecution();
    const result = {
      ...key('1'),
      httpStatus: 200,
      durationMs: 42,
      response: { ok: true },
      responseS3Key: null,
      createdAt: at(3),
    };
    expect(await repo.succeedExecution(key('1'), { status: ['IN_PROGRESS'] }, result)).toBe(false);
    expect(repo.getResult(key('1'))).toBeUndefined();

    await repo.claimExecution(key('1'), at(1), 360);
    expect(await repo.succeedExecution(key('1'), { status: ['IN_PROGRESS'] }, result)).toBe(true);
    expect(repo.getResult(key('1'))).toMatchObject({ httpStatus: 200, response: { ok: true } });
    expect(await repo.getExecution(key('1'))).toMatchObject({
      status: 'SUCCEEDED',
      finishedAt: at(3),
      lastHttpStatus: 200,
    });
  });

  it('queries by status with time filters and a keyset cursor', async () => {
    const repo = new InMemoryRepository();
    await repo.insertExecutions(
      ['1', '2', '10', '11'].map((id) => ({ ...key(id), providerId: 'p1' })),
      t0,
    );
    await repo.insertExecutions([{ ...key('3'), providerId: 'p1' }], at(100));
    for (const id of ['1', '10', '11']) await repo.claimExecution(key(id), at(0), 360);
    await repo.claimExecution(key('11'), at(500), 0); // re-claimed later: not stale yet

    const stale = await repo.findExecutions({
      runDate: day,
      status: 'IN_PROGRESS',
      startedBefore: at(100),
      limit: 10,
    });
    expect(stale.map((e) => e.registryId)).toEqual(['1', '10']);
    const page = await repo.findExecutions({
      runDate: day,
      status: 'IN_PROGRESS',
      after: '1',
      limit: 1,
    });
    expect(page.map((e) => e.registryId)).toEqual(['10']);
    const oldEnqueued = await repo.findExecutions({
      runDate: day,
      status: 'ENQUEUED',
      enqueuedBefore: at(50),
      limit: 10,
    });
    expect(oldEnqueued.map((e) => e.registryId)).toEqual(['2']);
  });

  it('reports counts by status and provider', async () => {
    const repo = new InMemoryRepository();
    await repo.insertExecutions(
      [
        { ...key('1'), providerId: 'a' },
        { ...key('2'), providerId: 'a' },
        { ...key('3'), providerId: 'b' },
        { registryId: '4', runDate: '2026-03-02', providerId: 'b' },
      ],
      t0,
    );
    await repo.claimExecution(key('1'), t0, 360);

    const stats = await repo.executionStats(day);
    expect(stats.total).toBe(3);
    expect(stats.byStatus).toMatchObject({ ENQUEUED: 2, IN_PROGRESS: 1, SUCCEEDED: 0 });
    expect(stats.byProvider).toEqual({ a: { ENQUEUED: 1, IN_PROGRESS: 1 }, b: { ENQUEUED: 1 } });
  });
});

describe('InMemoryRepository: dispatch windows', () => {
  it('begins, re-begins keeping started_at, and completes', async () => {
    const repo = new InMemoryRepository();
    expect(await repo.getDispatchWindow(day, 5)).toBeUndefined();

    await repo.beginDispatchWindow(day, 5, t0);
    await repo.beginDispatchWindow(day, 5, at(60));
    expect(await repo.getDispatchWindow(day, 5)).toMatchObject({
      status: 'PROCESSING',
      startedAt: t0,
    });

    await repo.completeDispatchWindow(day, 5, 42, at(61));
    expect(await repo.getDispatchWindow(day, 5)).toMatchObject({
      status: 'COMPLETED',
      jobsDispatched: 42,
      completedAt: at(61),
    });
    await repo.beginDispatchWindow(day, 5, at(120));
    expect((await repo.getDispatchWindow(day, 5))?.status).toBe('PROCESSING');
  });
});

describe('InMemoryRepository: circuits', () => {
  it('creates a row only if absent and updates only from the expected row', async () => {
    const repo = new InMemoryRepository();
    expect(await repo.getCircuit('p')).toBeUndefined();

    const closed = initialCircuit(defaults, t0);
    const failed = transition(closed, { type: 'FAILURE', owner: 'w1' }, at(1), defaults);
    expect(await repo.compareAndSetCircuit('p', undefined, failed)).toBe(true);
    expect(await repo.compareAndSetCircuit('p', undefined, failed)).toBe(false);

    const stored = await repo.getCircuit('p');
    expect(stored).toEqual(failed);
    if (!stored) throw new Error('missing');
    const failedTwice = transition(stored, { type: 'FAILURE', owner: 'w2' }, at(2), defaults);
    expect(await repo.compareAndSetCircuit('p', closed, failedTwice)).toBe(false);
    expect(await repo.compareAndSetCircuit('p', stored, failedTwice)).toBe(true);
    expect((await repo.getCircuit('p'))?.consecutiveFailures).toBe(2);
  });

  it('lets only one Worker win the HALF_OPEN probe', async () => {
    const repo = new InMemoryRepository();
    let open = initialCircuit(defaults, t0);
    for (let i = 0; i < defaults.cbFailureThreshold; i++) {
      open = transition(open, { type: 'FAILURE', owner: 'w' }, t0, defaults);
    }
    await repo.compareAndSetCircuit('p', undefined, open);

    const now = at(defaults.cbBaseCooldownS);
    const results = await Promise.all(
      ['w1', 'w2', 'w3'].map(async (owner) => {
        const current = await repo.getCircuit('p');
        if (!current) throw new Error('missing');
        const next = transition(current, { type: 'ACQUIRE_PROBE', owner }, now, defaults);
        return repo.compareAndSetCircuit('p', current, next);
      }),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await repo.getCircuit('p'))?.state).toBe('HALF_OPEN');
  });
});

describe('compareIds', () => {
  it('orders decimal strings numerically', () => {
    expect(['10', '9', '100', '1'].sort(compareIds)).toEqual(['1', '9', '10', '100']);
    expect(compareIds('7', '7')).toBe(0);
  });
});
