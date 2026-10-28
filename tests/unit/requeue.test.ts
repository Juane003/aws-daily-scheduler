import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../../src/adapters/memory/clock.js';
import { InMemoryFifoQueue } from '../../src/adapters/memory/fifo-queue.js';
import { InMemoryLogger } from '../../src/adapters/memory/logger.js';
import { InMemoryMetrics } from '../../src/adapters/memory/metrics.js';
import { defaults } from '../../src/common/config.js';
import { newJobMessage, nextMessage } from '../../src/common/message.js';
import { createRequeueHandler } from '../../src/handlers/requeue.js';

const t0 = new Date('2026-03-01T12:00:00Z');

function setup() {
  const clock = new VirtualClock(t0);
  const queue = new InMemoryFifoQueue(clock, { visibilityTimeoutS: 180 });
  const deadLetterQueue = new InMemoryFifoQueue(clock, { visibilityTimeoutS: 180 });
  const logger = new InMemoryLogger();
  const metrics = new InMemoryMetrics();
  const handler = createRequeueHandler({
    queue,
    deadLetterQueue,
    clock,
    logger,
    metrics,
    config: defaults,
  });
  return { queue, deadLetterQueue, logger, metrics, handler };
}

const retryBody = (registryId: string, seq = 1) =>
  JSON.stringify({
    ...nextMessage(newJobMessage(registryId, 'p1', '2026-03-01', 'DISPATCH', t0), 'RETRY', 1),
    seq,
  });

describe('Requeue', () => {
  it('moves retry messages back to the FIFO with dedup id jobId#seq', async () => {
    const { handler, queue, metrics } = setup();

    const response = await handler({
      Records: [
        { messageId: 'a', body: retryBody('1') },
        { messageId: 'b', body: retryBody('2', 3) },
      ],
    });

    expect(response).toEqual({ batchItemFailures: [] });
    const received = queue.receive(10);
    expect(received.map((m) => m.groupId)).toEqual(['p1']); // one per group in flight
    expect(JSON.parse(received[0]?.body ?? '{}')).toMatchObject({ jobId: '1#2026-03-01', seq: 1 });
    expect(queue.stats()).toEqual({ available: 1, inFlight: 1 });
    expect(metrics.total('JobsRequeued', { reason: 'RETRY' })).toBe(2);
  });

  it('lets the FIFO drop a duplicate delivery of the same retry message', async () => {
    const { handler, queue } = setup();
    await handler({ Records: [{ messageId: 'a', body: retryBody('1') }] });
    await handler({ Records: [{ messageId: 'a2', body: retryBody('1') }] });
    expect(queue.stats().available).toBe(1);
  });

  it('reports only the messages that could not be sent', async () => {
    const { handler, queue, logger } = setup();
    queue.failSend = (m) => m.deduplicationId.startsWith('2#');

    const response = await handler({
      Records: [
        { messageId: 'a', body: retryBody('1') },
        { messageId: 'b', body: retryBody('2') },
      ],
    });

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: 'b' }] });
    expect(logger.find('requeue failed')[0]?.fields).toMatchObject({
      messageId: 'b',
      jobId: '2#2026-03-01',
    });
  });

  it('sends an invalid message to the DLQ instead of retrying it forever', async () => {
    const { handler, queue, deadLetterQueue, metrics } = setup();
    const response = await handler({ Records: [{ messageId: 'x', body: '{"nope":1}' }] });
    expect(response).toEqual({ batchItemFailures: [] });
    expect(queue.stats().available).toBe(0);
    expect(JSON.parse(deadLetterQueue.peekBodies()[0] ?? '{}')).toMatchObject({
      reason: 'INVALID_MESSAGE',
      raw: '{"nope":1}',
    });
    expect(metrics.total('JobsFailed', { reason: 'INVALID_MESSAGE' })).toBe(1);
  });

  it('reports an invalid message whose DLQ send failed', async () => {
    const { handler, deadLetterQueue } = setup();
    deadLetterQueue.failSend = () => true;
    const response = await handler({ Records: [{ messageId: 'x', body: 'garbage' }] });
    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: 'x' }] });
  });
});
