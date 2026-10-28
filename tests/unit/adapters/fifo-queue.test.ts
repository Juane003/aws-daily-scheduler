import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../../../src/adapters/memory/clock.js';
import { InMemoryFifoQueue } from '../../../src/adapters/memory/fifo-queue.js';
import type { FifoMessage } from '../../../src/core/ports.js';

const msg = (body: string, groupId = 'p1', deduplicationId = body): FifoMessage => ({
  body,
  groupId,
  deduplicationId,
});

function setup(maxReceiveCount = 3) {
  const clock = new VirtualClock('2026-03-01T00:00:00Z');
  const dlq = new InMemoryFifoQueue(clock, { visibilityTimeoutS: 180 });
  const queue = new InMemoryFifoQueue(clock, {
    visibilityTimeoutS: 180,
    redrive: { deadLetterQueue: dlq, maxReceiveCount },
  });
  return { clock, queue, dlq };
}

describe('InMemoryFifoQueue: one message in flight per group', () => {
  it('does not deliver a second message of a group while the first is in flight', async () => {
    const { queue } = setup();
    await queue.send(msg('a1', 'A'));
    await queue.send(msg('a2', 'A'));
    await queue.send(msg('b1', 'B'));

    const first = queue.receive(10);
    expect(first.map((m) => m.body)).toEqual(['a1', 'b1']);
    expect(queue.receive(10)).toEqual([]);

    expect(queue.delete(first[0]?.receiptHandle ?? '')).toBe(true);
    expect(queue.receive(10).map((m) => m.body)).toEqual(['a2']);
  });

  it('keeps order within a group', async () => {
    const { queue } = setup();
    for (const body of ['1', '2', '3']) await queue.send(msg(body));
    const seen: string[] = [];
    for (let m = queue.receive()[0]; m !== undefined; m = queue.receive()[0]) {
      seen.push(m.body);
      queue.delete(m.receiptHandle);
    }
    expect(seen).toEqual(['1', '2', '3']);
  });
});

describe('InMemoryFifoQueue: deduplication', () => {
  it('drops a duplicate id within 5 minutes and accepts it after', async () => {
    const { clock, queue } = setup();
    await queue.send(msg('x', 'A', 'job#0'));
    clock.advanceSeconds(299);
    await queue.send(msg('x-again', 'A', 'job#0'));
    expect(queue.stats()).toEqual({ available: 1, inFlight: 0 });

    clock.advanceSeconds(1);
    await queue.send(msg('x-later', 'A', 'job#0'));
    expect(queue.stats().available).toBe(2);
  });

  it('does not extend the window on a duplicate', async () => {
    const { clock, queue } = setup();
    await queue.send(msg('x', 'A', 'job#0'));
    clock.advanceSeconds(200);
    await queue.send(msg('dup', 'A', 'job#0'));
    clock.advanceSeconds(100);
    await queue.send(msg('new', 'A', 'job#0'));
    expect(queue.stats().available).toBe(2);
  });

  it('deduplicates even after the original was consumed', async () => {
    const { queue } = setup();
    await queue.send(msg('x', 'A', 'job#0'));
    const [m] = queue.receive();
    queue.delete(m?.receiptHandle ?? '');
    await queue.send(msg('x', 'A', 'job#0'));
    expect(queue.receive()).toEqual([]);
  });

  it('treats a new seq as a new message', async () => {
    const { queue } = setup();
    await queue.send(msg('x', 'A', 'job#0'));
    await queue.send(msg('x', 'A', 'job#1'));
    expect(queue.stats().available).toBe(2);
  });

  it('scopes deduplication to the message group (high-throughput mode)', async () => {
    const { queue } = setup();
    await queue.send(msg('x', 'A', 'same'));
    await queue.send(msg('x', 'B', 'same'));
    expect(queue.stats().available).toBe(2);
  });
});

describe('InMemoryFifoQueue: visibility timeout', () => {
  it('redelivers an undeleted message after the timeout, still blocking its group', async () => {
    const { clock, queue } = setup();
    await queue.send(msg('a1', 'A'));
    await queue.send(msg('a2', 'A'));
    const [first] = queue.receive();

    clock.advanceSeconds(179);
    expect(queue.receive()).toEqual([]);
    clock.advanceSeconds(1);
    const [again] = queue.receive();
    expect(again).toMatchObject({ body: 'a1', receiveCount: 2 });
    expect(again?.receiptHandle).not.toBe(first?.receiptHandle);
    expect(queue.nextVisibilityAt()).toEqual(new Date('2026-03-01T00:06:00Z'));
  });

  it('ignores a delete with a stale receipt handle', async () => {
    const { clock, queue } = setup();
    await queue.send(msg('a1'));
    const [first] = queue.receive();
    clock.advanceSeconds(180);
    const [second] = queue.receive();

    expect(queue.delete(first?.receiptHandle ?? '')).toBe(false);
    expect(queue.stats()).toEqual({ available: 0, inFlight: 1 });
    expect(queue.delete(second?.receiptHandle ?? '')).toBe(true);
    expect(queue.stats()).toEqual({ available: 0, inFlight: 0 });
  });
});

describe('InMemoryFifoQueue: redrive', () => {
  it('moves a message to the DLQ after maxReceiveCount receives', async () => {
    const { clock, queue, dlq } = setup(3);
    await queue.send(msg('poison', 'A'));
    await queue.send(msg('next', 'A'));

    for (let i = 1; i <= 3; i++) {
      expect(queue.receive()[0]).toMatchObject({ body: 'poison', receiveCount: i });
      clock.advanceSeconds(180);
    }
    // The fourth receive moves it to the DLQ and the group moves on.
    expect(queue.receive()[0]?.body).toBe('next');
    expect(dlq.peekBodies()).toEqual(['poison']);
    expect(dlq.receive()[0]).toMatchObject({ body: 'poison', groupId: 'A', receiveCount: 1 });
  });
});

describe('InMemoryFifoQueue: sending', () => {
  it('reports per-entry failures in a batch without throwing', async () => {
    const { queue } = setup();
    queue.failSend = (m) => m.body === 'bad';
    const result = await queue.sendBatch([msg('ok1'), msg('bad'), msg('ok2')]);
    expect(result.failed.map((f) => f.index)).toEqual([1]);
    expect(result.failed[0]?.error).toContain('injected');
    expect(queue.stats().available).toBe(2);
  });

  it('rejects a failed single send', async () => {
    const { queue } = setup();
    queue.failSend = () => true;
    await expect(queue.send(msg('x'))).rejects.toThrow('injected');
  });

  it('enforces SQS limits', async () => {
    const { queue } = setup();
    await expect(queue.sendBatch([])).rejects.toThrow(RangeError);
    await expect(
      queue.sendBatch(Array.from({ length: 11 }, (_, i) => msg(`${i}`))),
    ).rejects.toThrow(RangeError);
    await expect(queue.send(msg('x'.repeat(262_145)))).rejects.toThrow(RangeError);
    await expect(queue.send(msg('x', 'g'.repeat(129)))).rejects.toThrow(RangeError);
    expect(() => queue.receive(11)).toThrow(RangeError);
  });
});
