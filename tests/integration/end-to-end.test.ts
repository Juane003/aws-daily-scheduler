import { describe, expect, it } from 'vitest';
import type { DeadLetter } from '../../src/common/message.js';
import { isTerminal, type Registry } from '../../src/core/model.js';
import { Harness, SimulatedCrash } from '../../src/simulation/harness.js';

/**
 * End-to-end in memory: Dispatcher → FIFO → Worker → API simulator → retry/Requeue → DLQ →
 * Reconciler, on a virtual clock. A simulation, not a benchmark: it checks behaviour, not speed.
 */

const day = '2026-03-01';

function registries(count: number, providers: readonly string[], slots: number): Registry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: String(i + 1),
    providerId: providers[i % providers.length] ?? 'p0',
    endpoint: '/q',
    httpMethod: 'POST',
    body: { i },
    slot: i % slots,
    enabled: true,
  }));
}

/** `idle`: nothing may be left in any queue (false when the run already reached the next day). */
function assertInvariants(h: Harness, rows: readonly Registry[], idle = true) {
  const runDate = day;
  const executions = h.repository.allExecutions().filter((e) => e.runDate === runDate);
  // Every registry has exactly one execution for the day, and it finished.
  expect(executions).toHaveLength(rows.length);
  expect(executions.filter((e) => !isTerminal(e.status))).toEqual([]);
  // Never two simultaneous calls to the same provider.
  for (const [provider, peak] of h.api.peakConcurrency()) {
    expect(peak, `peak concurrency of ${provider}`).toBeLessThanOrEqual(1);
  }
  // Nothing left in flight.
  if (idle) expect(h.pendingWork()).toBe(0);
  // Every success has its result; every failure has its dead letter.
  for (const e of executions.filter((x) => x.status === 'SUCCEEDED')) {
    expect(h.repository.getResult(e), e.registryId).toBeDefined();
  }
  const letters = h.deadLetterQueue.peekBodies().map((b) => JSON.parse(b) as DeadLetter);
  const failed = executions.filter((e) => e.status !== 'SUCCEEDED');
  expect(letters.map((l) => l.message?.jobId).sort()).toEqual(
    failed.map((e) => `${e.registryId}#${e.runDate}`).sort(),
  );
  return executions;
}

describe('end to end', () => {
  it('runs a day with mixed failures: every job ends terminal, one call at a time per provider', async () => {
    const providers = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
    const rows = registries(400, providers, 120);
    const h = new Harness({
      start: `${day}T00:00:00Z`,
      registries: rows,
      seed: 42,
      profiles: {
        p0: { latencyMs: [500, 3000], error5xxRate: 0.2, error4xxRate: 0.05 },
        p1: { latencyMs: [1000, 12_000] }, // some calls exceed httpTimeoutMs (10 s)
        p2: { error5xxRate: 0.05, error4xxRate: 0.02 },
        p3: { error5xxRate: 0.05, error4xxRate: 0.02 },
      },
    });

    await h.runUntil(`${day}T06:00:00Z`);

    const executions = assertInvariants(h, rows);
    expect(h.workerErrors).toEqual([]);
    // Without crashes, each call is exactly one counted attempt.
    const callsPerJob = new Map<string, number>();
    for (const c of h.api.calls) {
      callsPerJob.set(c.idempotencyKey, (callsPerJob.get(c.idempotencyKey) ?? 0) + 1);
    }
    for (const e of executions) {
      expect(callsPerJob.get(`${e.registryId}#${e.runDate}`) ?? 0, e.registryId).toBe(e.attempt);
    }
    // The mix actually exercised the branches.
    const counts = h.statusCounts(day);
    expect(counts.SUCCEEDED).toBeGreaterThan(300);
    expect(counts.FAILED_NON_RETRYABLE).toBeGreaterThan(0);
    expect(h.metrics.total('RetryScheduled')).toBeGreaterThan(0);
    expect(h.api.calls.some((c) => c.outcome === 'TIMEOUT')).toBe(true);
  });

  it('opens the breaker for a provider returning 100% 503 and sends it no calls while OPEN', async () => {
    const rows = registries(60, ['down', 'up'], 30);
    const h = new Harness({
      start: `${day}T00:00:00Z`,
      registries: rows,
      seed: 7,
      profiles: { down: { error5xxRate: 1 } },
    });

    // Past the deadline of the day (end of day + expiryGraceH), so every job is terminal.
    await h.runUntil('2026-03-02T07:00:00Z');

    const executions = assertInvariants(h, rows, false);
    // What is still queued is the next day's work for the broken provider, still being deferred.
    expect(h.statusCounts('2026-03-02')).toEqual({ SUCCEEDED: 30, RETRYING: 30 });
    expect(h.pendingWork()).toBe(30);
    expect(h.metrics.dimensionsOf('CircuitStateChange')).toContainEqual({
      provider: 'down',
      from: 'CLOSED',
      to: 'OPEN',
    });

    const openWindows = h.repository.circuitHistory
      .filter((w) => w.providerId === 'down' && w.state.state === 'OPEN')
      .map((w) => [w.at, w.state.openUntil?.getTime() ?? w.at] as const);
    expect(openWindows.length).toBeGreaterThan(1); // reopened after failed probes
    const downCalls = h.api.callsTo('down');
    for (const [from, until] of openWindows) {
      expect(downCalls.filter((c) => c.startedAt >= from && c.startedAt < until)).toEqual([]);
    }

    // The healthy provider is unaffected; the broken one is contained.
    const byProvider = (p: string) => executions.filter((e) => e.providerId === p);
    expect(byProvider('up').every((e) => e.status === 'SUCCEEDED')).toBe(true);
    expect(
      byProvider('down').every((e) => ['FAILED_EXHAUSTED', 'FAILED_EXPIRED'].includes(e.status)),
    ).toBe(true);
    expect(downCalls.length).toBeLessThan(30 * h.config.maxAttempts);
    expect(h.metrics.total('JobsDeferred', { provider: 'down' })).toBeGreaterThan(0);
  });

  it('loses no job and writes no duplicate result when Workers crash before or after the call', async () => {
    const rows = registries(20, ['a', 'b'], 20);
    const h = new Harness({ start: `${day}T00:00:00Z`, registries: rows, seed: 3 });
    for (const id of ['3', '7']) h.repository.crashBeforeCall.add(id);
    for (const id of ['5', '12']) h.repository.crashAfterCall.add(id);

    // The Reconciler at 01:00:30 recovers the stale claims.
    await h.runUntil(`${day}T02:00:00Z`);

    const executions = assertInvariants(h, rows);
    expect(h.workerErrors).toHaveLength(4);
    expect(h.workerErrors.every((e) => e instanceof SimulatedCrash)).toBe(true);
    expect(executions.every((e) => e.status === 'SUCCEEDED')).toBe(true);

    const calls = (id: string) => h.api.calls.filter((c) => c.idempotencyKey === `${id}#${day}`);
    const attempt = (id: string) => executions.find((e) => e.registryId === id)?.attempt;
    // Crash before the call: the API was called once, after the recovery.
    for (const id of ['3', '7']) {
      expect(calls(id)).toHaveLength(1);
      expect(attempt(id)).toBe(2);
    }
    // Crash after the call: called again with the same Idempotency-Key; one result stored.
    for (const id of ['5', '12']) {
      expect(calls(id)).toHaveLength(2);
      expect(attempt(id)).toBe(2);
    }
    expect(calls('1')).toHaveLength(1);
    expect(h.metrics.total('JobsSucceeded')).toBe(20);
  });
});
