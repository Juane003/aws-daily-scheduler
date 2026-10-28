import { Worker, type WorkerDeps, type WorkerOutcome } from '../core/execute/worker.js';

/**
 * Worker Lambda — reference implementation, not deployed. In the target design it is invoked by
 * the SQS FIFO event source mapping with `BatchSize = 1` (D6); here the simulation harness calls it
 * with in-memory adapters. Returning acknowledges the message; an exception makes SQS redeliver it
 * after the visibility timeout.
 */

/** The subset of the SQS event the Worker uses. */
export interface SqsEvent {
  Records: readonly { messageId: string; body: string }[];
}

export function createWorkerHandler(
  deps: WorkerDeps,
): (event: SqsEvent) => Promise<WorkerOutcome[]> {
  const worker = new Worker(deps);
  return async (event) => {
    const outcomes: WorkerOutcome[] = [];
    for (const record of event.Records) outcomes.push(await worker.handle(record.body));
    return outcomes;
  };
}
