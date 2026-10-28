import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../../../src/adapters/memory/clock.js';
import { InMemoryStandardQueue } from '../../../src/adapters/memory/standard-queue.js';

function setup(maxReceiveCount = 3) {
  const clock = new VirtualClock('2026-03-01T00:00:00Z');
  const dlq = new InMemoryStandardQueue(clock, { visibilityTimeoutS: 30 });
  const queue = new InMemoryStandardQueue(clock, {
    visibilityTimeoutS: 30,
    redrive: { deadLetterQueue: dlq, maxReceiveCount },
  });
  return { clock, queue, dlq };
}

describe('InMemoryStandardQueue: DelaySeconds', () => {
  it('keeps a delayed message invisible until the delay elapses', async () => {
    const { clock, queue } = setup();
    await queue.send('later', 90);
    await queue.send('now');

    expect(queue.receive(10).map((m) => m.body)).toEqual(['now']);
    expect(queue.stats()).toEqual({ available: 1, inFlight: 1 });
    expect(queue.nextVisibilityAt()).toEqual(new Date('2026-03-01T00:00:30Z'));

    clock.advanceSeconds(89);
    expect(queue.receive(10).map((m) => m.body)).toEqual(['now']); // its visibility expired at 30 s
    clock.advanceSeconds(1);
    expect(queue.receive(10).map((m) => m.body)).toEqual(['later']);
  });

  it('delivers delayed messages in due-time order', async () => {
    const { clock, queue } = setup();
    await queue.send('c', 300);
    await queue.send('a', 100);
    await queue.send('b', 200);
    clock.advanceSeconds(300);
    expect(queue.receive(10).map((m) => m.body)).toEqual(['a', 'b', 'c']);
  });

  it('accepts 0..900 integer seconds only', async () => {
    const { queue } = setup();
    await expect(queue.send('x', 900)).resolves.toBeUndefined();
    await expect(queue.send('x', 901)).rejects.toThrow(RangeError);
    await expect(queue.send('x', -1)).rejects.toThrow(RangeError);
    await expect(queue.send('x', 1.5)).rejects.toThrow(RangeError);
  });
});

describe('InMemoryStandardQueue: visibility and redrive', () => {
  it('deletes with the current handle only', async () => {
    const { clock, queue } = setup();
    await queue.send('x');
    const [first] = queue.receive();
    clock.advanceSeconds(30);
    const [second] = queue.receive();
    expect(second?.receiveCount).toBe(2);
    expect(queue.delete(first?.receiptHandle ?? '')).toBe(false);
    expect(queue.delete(second?.receiptHandle ?? '')).toBe(true);
    expect(queue.stats()).toEqual({ available: 0, inFlight: 0 });
    clock.advanceSeconds(30);
    expect(queue.receive()).toEqual([]);
  });

  it('moves a message to its DLQ after maxReceiveCount receives', async () => {
    const { clock, queue, dlq } = setup(2);
    await queue.send('poison');
    queue.receive();
    clock.advanceSeconds(30);
    queue.receive();
    clock.advanceSeconds(30);
    expect(queue.receive()).toEqual([]);
    expect(dlq.peekBodies()).toEqual(['poison']);
  });

  it('rejects an injected send failure', async () => {
    const { queue } = setup();
    queue.failSend = (_body, delay) => delay > 0;
    await expect(queue.send('x', 10)).rejects.toThrow('injected');
    await expect(queue.send('x')).resolves.toBeUndefined();
  });
});
