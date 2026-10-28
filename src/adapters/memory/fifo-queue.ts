import type { Clock, FifoMessage, FifoQueue, SendBatchResult } from '../../core/ports.js';
import { Deque, MinHeap } from './collections.js';
import {
  InjectedSendError,
  MAX_ID_LENGTH,
  assertBatch,
  assertBody,
  assertReceiveCount,
  deliver,
  type QueueStats,
  type ReceivedMessage,
  type StoredMessage,
} from './queue-common.js';

/**
 * In-memory SQS FIFO queue (D5, D9) with the semantics the design relies on:
 *
 * - **One message in flight per `MessageGroupId`.** While a group has a message in flight, none of
 *   its other messages is delivered; that is what keeps two calls to one provider from overlapping.
 *   Real SQS may hand several messages of one group to a single receive; with the ESM at
 *   `BatchSize = 1` (D6) that does not happen, so this adapter delivers at most one per group.
 * - **Deduplication** by `MessageDeduplicationId` for 5 minutes, scoped to the message group as in
 *   high-throughput mode. A duplicate is accepted and dropped; the window is not extended.
 * - **Visibility timeout:** an undeleted message becomes visible again, at the head of its group.
 * - **Redrive:** a message already received `maxReceiveCount` times moves to the DLQ on the next
 *   receive instead of being delivered.
 *
 * Time comes from the injected {@link Clock}; nothing happens until someone calls a method.
 */

export interface FifoQueueOptions {
  visibilityTimeoutS: number;
  deduplicationWindowS?: number;
  redrive?: { deadLetterQueue: InMemoryFifoQueue; maxReceiveCount: number };
}

interface Group {
  id: string;
  messages: Deque<StoredMessage>;
  inFlight: StoredMessage | null;
  /** Whether the group is in `ready`. */
  queued: boolean;
}

interface Expiration {
  atMs: number;
  groupId: string;
  receipt: string;
}

export class InMemoryFifoQueue implements FifoQueue {
  /** Fault injection: when it returns true for a message, the send fails. */
  failSend: ((message: FifoMessage) => boolean) | undefined;

  private readonly groups = new Map<string, Group>();
  /** Groups with a deliverable head, in the order they became ready. */
  private readonly ready = new Deque<string>();
  private readonly expirations = new MinHeap<Expiration>((a, b) => a.atMs < b.atMs);
  /** `groupId \0 deduplicationId` → expiry. Insertion order is expiry order. */
  private readonly dedup = new Map<string, number>();
  /** Current receipt handle → group of the in-flight message. */
  private readonly receipts = new Map<string, string>();
  private readonly deduplicationWindowMs: number;
  private stored = 0;
  private inFlight = 0;
  private nextId = 1;

  constructor(
    private readonly clock: Clock,
    private readonly options: FifoQueueOptions,
  ) {
    this.deduplicationWindowMs = (options.deduplicationWindowS ?? 300) * 1000;
  }

  send(message: FifoMessage): Promise<void> {
    try {
      this.sendOne(message);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  sendBatch(messages: readonly FifoMessage[]): Promise<SendBatchResult> {
    try {
      assertBatch(messages.length);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const failed: { index: number; error: string }[] = [];
    messages.forEach((message, index) => {
      try {
        this.sendOne(message);
      } catch (error) {
        failed.push({ index, error: error instanceof Error ? error.message : String(error) });
      }
    });
    return Promise.resolve({ failed });
  }

  receive(maxMessages = 1): ReceivedMessage[] {
    assertReceiveCount(maxMessages);
    this.expireVisibility();
    const out: ReceivedMessage[] = [];
    const redrive = this.options.redrive;
    while (out.length < maxMessages) {
      const groupId = this.ready.shift();
      if (groupId === undefined) break;
      const group = this.groups.get(groupId);
      if (group === undefined) continue;
      group.queued = false;
      const head = group.messages.peek();
      if (head === undefined || group.inFlight !== null) continue;
      if (redrive !== undefined && head.receiveCount >= redrive.maxReceiveCount) {
        this.removeHead(group);
        redrive.deadLetterQueue.acceptRedrive(head);
        this.markReady(group);
        continue;
      }
      const received = deliver(head);
      group.inFlight = head;
      this.inFlight++;
      this.receipts.set(received.receiptHandle, groupId);
      this.expirations.push({
        atMs: this.clock.now().getTime() + this.options.visibilityTimeoutS * 1000,
        groupId,
        receipt: received.receiptHandle,
      });
      out.push(received);
    }
    return out;
  }

  /** Returns `false` for a handle that is no longer current (the message is not deleted). */
  delete(receiptHandle: string): boolean {
    this.expireVisibility();
    const groupId = this.receipts.get(receiptHandle);
    const group = groupId === undefined ? undefined : this.groups.get(groupId);
    if (group?.inFlight?.receipt !== receiptHandle) return false;
    this.receipts.delete(receiptHandle);
    group.inFlight = null;
    this.inFlight--;
    this.removeHead(group);
    this.markReady(group);
    return true;
  }

  /** Called by the source queue's redrive policy; keeps the group and the original send time. */
  acceptRedrive(message: StoredMessage): void {
    this.append({ ...message, receiveCount: 0, receipt: null });
  }

  stats(): QueueStats {
    this.expireVisibility();
    return { available: this.stored - this.inFlight, inFlight: this.inFlight };
  }

  /** Earliest time an in-flight message may become visible again; lets a harness skip idle time. */
  nextVisibilityAt(): Date | undefined {
    const next = this.expirations.peek();
    return next === undefined ? undefined : new Date(next.atMs);
  }

  /** All stored message bodies in group order, without receiving them (DLQ inspection in tests). */
  peekBodies(): string[] {
    const bodies: string[] = [];
    for (const group of this.groups.values()) {
      for (const message of group.messages) bodies.push(message.body);
    }
    return bodies;
  }

  private sendOne(message: FifoMessage): void {
    assertBody(message.body);
    assertId('groupId', message.groupId);
    assertId('deduplicationId', message.deduplicationId);
    if (this.failSend?.(message) === true) {
      throw new InjectedSendError(`injected send failure for ${message.deduplicationId}`);
    }
    const nowMs = this.clock.now().getTime();
    this.pruneDedup(nowMs);
    const dedupKey = `${message.groupId}\u0000${message.deduplicationId}`;
    if (this.dedup.has(dedupKey)) return;
    this.dedup.set(dedupKey, nowMs + this.deduplicationWindowMs);
    this.append({
      messageId: `m-${this.nextId++}`,
      body: message.body,
      groupId: message.groupId,
      sentAtMs: nowMs,
      receiveCount: 0,
      receipt: null,
    });
  }

  private append(message: StoredMessage): void {
    const groupId = message.groupId ?? '';
    let group = this.groups.get(groupId);
    if (group === undefined) {
      group = { id: groupId, messages: new Deque(), inFlight: null, queued: false };
      this.groups.set(groupId, group);
    }
    group.messages.push(message);
    this.stored++;
    this.markReady(group);
  }

  private removeHead(group: Group): void {
    group.messages.shift();
    this.stored--;
    if (group.messages.size === 0 && group.inFlight === null) this.groups.delete(group.id);
  }

  private markReady(group: Group): void {
    if (group.queued || group.inFlight !== null || group.messages.size === 0) return;
    group.queued = true;
    this.ready.push(group.id);
  }

  private expireVisibility(): void {
    const nowMs = this.clock.now().getTime();
    for (let next = this.expirations.peek(); next !== undefined && next.atMs <= nowMs;) {
      this.expirations.pop();
      const group = this.groups.get(next.groupId);
      // Stale entries (message deleted or re-received since) are skipped.
      if (group?.inFlight?.receipt === next.receipt) {
        this.receipts.delete(next.receipt);
        group.inFlight.receipt = null;
        group.inFlight = null;
        this.inFlight--;
        this.markReady(group);
      }
      next = this.expirations.peek();
    }
  }

  private pruneDedup(nowMs: number): void {
    for (const [key, expiresAt] of this.dedup) {
      if (expiresAt > nowMs) break;
      this.dedup.delete(key);
    }
  }
}

function assertId(name: string, value: string): void {
  if (value.length < 1 || value.length > MAX_ID_LENGTH) {
    throw new RangeError(`${name} must be 1..${MAX_ID_LENGTH} characters`);
  }
}
