import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../../../src/adapters/memory/clock.js';
import { Deque, MinHeap } from '../../../src/adapters/memory/collections.js';
import { InMemoryLogger } from '../../../src/adapters/memory/logger.js';
import { InMemoryMetrics } from '../../../src/adapters/memory/metrics.js';
import { InMemoryObjectStore } from '../../../src/adapters/memory/object-store.js';
import { createRng } from '../../../src/simulation/registries.js';

describe('VirtualClock', () => {
  it('only moves forward when advanced', () => {
    const clock = new VirtualClock('2026-03-01T00:00:00Z');
    expect(clock.now()).toEqual(new Date('2026-03-01T00:00:00Z'));
    clock.advanceSeconds(90);
    clock.advanceMs(500);
    expect(clock.now()).toEqual(new Date('2026-03-01T00:01:30.500Z'));
    clock.advanceTo(new Date('2026-03-02T00:00:00Z'));
    expect(clock.now()).toEqual(new Date('2026-03-02T00:00:00Z'));
  });

  it('refuses to go backwards or start from an invalid date', () => {
    const clock = new VirtualClock('2026-03-01T00:00:00Z');
    expect(() => clock.advanceTo(new Date('2026-02-28T00:00:00Z'))).toThrow(RangeError);
    expect(() => clock.advanceMs(Number.NaN)).toThrow(RangeError);
    expect(() => new VirtualClock('not a date')).toThrow(RangeError);
  });

  it('returns a fresh Date each time', () => {
    const clock = new VirtualClock('2026-03-01T00:00:00Z');
    clock.now().setFullYear(2000);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });
});

describe('collections', () => {
  it('MinHeap pops in order', () => {
    const heap = new MinHeap<number>((a, b) => a < b);
    const rng = createRng(7);
    const values = Array.from({ length: 1000 }, () => Math.floor(rng() * 100));
    for (const v of values) heap.push(v);
    const popped: number[] = [];
    for (let v = heap.pop(); v !== undefined; v = heap.pop()) popped.push(v);
    expect(popped).toEqual([...values].sort((a, b) => a - b));
    expect(heap.size).toBe(0);
  });

  it('Deque keeps FIFO order across compaction', () => {
    const deque = new Deque<number>();
    for (let i = 0; i < 5000; i++) deque.push(i);
    for (let i = 0; i < 3000; i++) expect(deque.shift()).toBe(i);
    expect(deque.size).toBe(2000);
    expect(deque.peek()).toBe(3000);
    expect([...deque].slice(0, 2)).toEqual([3000, 3001]);
    while (deque.shift() !== undefined);
    expect(deque.shift()).toBeUndefined();
  });
});

describe('InMemoryMetrics', () => {
  it('sums counters by name and dimension subset', () => {
    const metrics = new InMemoryMetrics();
    metrics.count('JobsFailed', { reason: 'EXPIRED' });
    metrics.count('JobsFailed', { reason: 'NON_RETRYABLE' }, 2);
    metrics.count('JobsSucceeded');

    expect(metrics.total('JobsFailed')).toBe(3);
    expect(metrics.total('JobsFailed', { reason: 'EXPIRED' })).toBe(1);
    expect(metrics.total('Missing')).toBe(0);
    expect(metrics.dimensionsOf('JobsFailed')).toEqual([
      { reason: 'EXPIRED' },
      { reason: 'NON_RETRYABLE' },
    ]);
  });

  it('keeps observations', () => {
    const metrics = new InMemoryMetrics();
    metrics.record('DownstreamLatency', 120, { provider: 'a' });
    metrics.record('DownstreamLatency', 80, { provider: 'b' });
    expect(metrics.values('DownstreamLatency')).toEqual([120, 80]);
    expect(metrics.values('DownstreamLatency', { provider: 'b' })).toEqual([80]);
  });
});

describe('InMemoryLogger', () => {
  it('captures events for assertions', () => {
    const logger = new InMemoryLogger();
    logger.log('info', 'job claimed', { jobId: '1#2026-03-01' });
    logger.log('warn', 'breaker open');
    expect(logger.find('job claimed')).toEqual([
      { level: 'info', message: 'job claimed', fields: { jobId: '1#2026-03-01' } },
    ]);
    expect(logger.atLevel('warn')).toHaveLength(1);
  });
});

describe('InMemoryObjectStore', () => {
  it('stores and returns objects', async () => {
    const store = new InMemoryObjectStore();
    await store.put('results/1', '{"big":true}');
    expect(store.get('results/1')).toBe('{"big":true}');
    expect(store.size).toBe(1);
  });
});
