import type { Clock, StandardQueue } from '../../core/ports.js';
import { Deque, MinHeap } from './collections.js';
import {
  InjectedSendError,
  MAX_DELAY_SECONDS,
  assertBody,
  assertReceiveCount,
  deliver,
  type QueueStats,
  type ReceivedMessage,
  type StoredMessage,
} from './queue-common.js';

/**
 * In-memory SQS standard queue: the `retry` queue (D7) and its DLQ (D9).
 *
 * - **`DelaySeconds`** per message (0..900): the message is invisible until the delay elapses.
 * - **Visibility timeout** and **redrive** by `maxReceiveCount`, as in the FIFO adapter.
 * - No ordering and no deduplication. Real SQS standard may also deliver a message twice; this
 *   adapter does not inject duplicates, the consumers are idempotent anyway (FIFO dedup + claim).
 */

export interface StandardQueueOptions {
  visibilityTimeoutS: number;
  redrive?: { deadLetterQueue: InMemoryStandardQueue; maxReceiveCount: number };
}

/** A message that becomes available at `atMs`: delayed (`receipt = null`) or in flight. */
interface Pending {
  atMs: number;
  order: number;
  message: StoredMessage;
  receipt: string | null;
}

export class InMemoryStandardQueue implements StandardQueue {
  /** Fault injection: when it returns true for a body, the send fails. */
  failSend: ((body: string, delaySeconds: number) => boolean) | undefined;

  private readonly ready = new Deque<StoredMessage>();
  private readonly pending = new MinHeap<Pending>((a, b) =>
    a.atMs === b.atMs ? a.order < b.order : a.atMs < b.atMs,
  );
  private readonly inFlight = new Map<string, StoredMessage>();
  private delayed = 0;
  private nextId = 1;
  private nextOrder = 0;

  constructor(
    private readonly clock: Clock,
    private readonly options: StandardQueueOptions,
  ) {}

  send(body: string, delaySeconds = 0): Promise<void> {
    try {
      this.sendOne(body, delaySeconds);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  receive(maxMessages = 1): ReceivedMessage[] {
    assertReceiveCount(maxMessages);
    this.promote();
    const out: ReceivedMessage[] = [];
    const redrive = this.options.redrive;
    while (out.length < maxMessages) {
      const message = this.ready.shift();
      if (message === undefined) break;
      if (redrive !== undefined && message.receiveCount >= redrive.maxReceiveCount) {
        redrive.deadLetterQueue.acceptRedrive(message);
        continue;
      }
      const received = deliver(message);
      this.inFlight.set(received.receiptHandle, message);
      this.pending.push({
        atMs: this.clock.now().getTime() + this.options.visibilityTimeoutS * 1000,
        order: this.nextOrder++,
        message,
        receipt: received.receiptHandle,
      });
      out.push(received);
    }
    return out;
  }

  /** Returns `false` for a handle that is no longer current (the message is not deleted). */
  delete(receiptHandle: string): boolean {
    this.promote();
    const message = this.inFlight.get(receiptHandle);
    if (message === undefined) return false;
    this.inFlight.delete(receiptHandle);
    message.receipt = null;
    return true;
  }

  acceptRedrive(message: StoredMessage): void {
    this.ready.push({ ...message, receiveCount: 0, receipt: null });
  }

  stats(): QueueStats {
    this.promote();
    return { available: this.ready.size + this.delayed, inFlight: this.inFlight.size };
  }

  /** Earliest time a delayed or in-flight message may become visible. */
  nextVisibilityAt(): Date | undefined {
    const next = this.pending.peek();
    return next === undefined ? undefined : new Date(next.atMs);
  }

  peekBodies(): string[] {
    this.promote();
    return [...this.ready].map((m) => m.body);
  }

  private sendOne(body: string, delaySeconds: number): void {
    assertBody(body);
    if (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > MAX_DELAY_SECONDS) {
      throw new RangeError(`delaySeconds must be an integer 0..${MAX_DELAY_SECONDS}`);
    }
    if (this.failSend?.(body, delaySeconds) === true) {
      throw new InjectedSendError('injected send failure');
    }
    const nowMs = this.clock.now().getTime();
    const message: StoredMessage = {
      messageId: `m-${this.nextId++}`,
      body,
      groupId: undefined,
      sentAtMs: nowMs,
      receiveCount: 0,
      receipt: null,
    };
    if (delaySeconds === 0) {
      this.ready.push(message);
      return;
    }
    this.delayed++;
    this.pending.push({
      atMs: nowMs + delaySeconds * 1000,
      order: this.nextOrder++,
      message,
      receipt: null,
    });
  }

  /** Moves delayed messages whose delay elapsed, and expired in-flight ones, to `ready`. */
  private promote(): void {
    const nowMs = this.clock.now().getTime();
    for (let next = this.pending.peek(); next !== undefined && next.atMs <= nowMs;) {
      this.pending.pop();
      if (next.receipt === null) {
        this.delayed--;
        this.ready.push(next.message);
      } else if (next.message.receipt === next.receipt) {
        // Still in flight with the same handle: the visibility timeout expired.
        this.inFlight.delete(next.receipt);
        next.message.receipt = null;
        this.ready.push(next.message);
      }
      next = this.pending.peek();
    }
  }
}
