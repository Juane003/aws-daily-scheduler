/** Pieces shared by the in-memory FIFO and standard queues. Limits follow the SQS quotas. */

export const MAX_MESSAGE_BYTES = 262_144;
export const MAX_BATCH_ENTRIES = 10;
export const MAX_DELAY_SECONDS = 900;
export const MAX_ID_LENGTH = 128;

/** What a consumer (the ESM, in AWS) gets from `ReceiveMessage`. */
export interface ReceivedMessage {
  messageId: string;
  body: string;
  /** Only the latest handle of a message can delete it. */
  receiptHandle: string;
  /** `ApproximateReceiveCount`, including this delivery. */
  receiveCount: number;
  sentAt: Date;
  groupId?: string;
}

/** A message as stored by the queue; `receipt` is set while it is in flight. */
export interface StoredMessage {
  messageId: string;
  body: string;
  groupId: string | undefined;
  sentAtMs: number;
  receiveCount: number;
  receipt: string | null;
}

export interface QueueStats {
  /** Stored and not in flight (includes delayed messages in a standard queue). */
  available: number;
  inFlight: number;
}

export class InjectedSendError extends Error {
  override readonly name = 'InjectedSendError';
}

export function assertBody(body: string): void {
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MAX_MESSAGE_BYTES) {
    throw new RangeError(`message is ${bytes} bytes, the limit is ${MAX_MESSAGE_BYTES}`);
  }
}

export function assertBatch(length: number): void {
  if (length < 1 || length > MAX_BATCH_ENTRIES) {
    throw new RangeError(`a batch has 1..${MAX_BATCH_ENTRIES} entries, got ${length}`);
  }
}

export function assertReceiveCount(maxMessages: number): void {
  if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > MAX_BATCH_ENTRIES) {
    throw new RangeError(`maxMessages must be 1..${MAX_BATCH_ENTRIES}, got ${maxMessages}`);
  }
}

export function deliver(message: StoredMessage): ReceivedMessage {
  message.receiveCount++;
  message.receipt = `${message.messageId}:${message.receiveCount}`;
  const received: ReceivedMessage = {
    messageId: message.messageId,
    body: message.body,
    receiptHandle: message.receipt,
    receiveCount: message.receiveCount,
    sentAt: new Date(message.sentAtMs),
  };
  if (message.groupId !== undefined) received.groupId = message.groupId;
  return received;
}
