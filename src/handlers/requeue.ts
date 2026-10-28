import { Requeue, type BatchResponse, type RequeueDeps } from '../core/execute/requeue.js';
import type { SqsEvent } from './worker.js';

/**
 * Requeue Lambda — reference implementation, not deployed. In the target design it consumes the
 * standard `retry` queue (batch of 10, `ReportBatchItemFailures`) and moves each message back to
 * the FIFO once its `DelaySeconds` elapsed (D7).
 */
export function createRequeueHandler(
  deps: RequeueDeps,
): (event: SqsEvent) => Promise<BatchResponse> {
  const requeue = new Requeue(deps);
  return (event) => requeue.handleBatch(event.Records);
}
