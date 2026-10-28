import { Dispatcher, type DispatcherDeps, type SlotOutcome } from '../core/dispatch/dispatcher.js';

/**
 * Dispatcher Lambda — reference implementation, not deployed. In the target design EventBridge
 * Scheduler invokes it every minute (D2); here the simulation harness calls it with in-memory
 * adapters. The handler stays thin: wiring only, the logic lives in `core/dispatch`.
 *
 * It does not throw when a window fails: the window stays `PROCESSING` and the next tick's
 * lookback retries it, which is faster and cheaper than an EventBridge retry of the whole tick.
 */
export function createDispatcherHandler(deps: DispatcherDeps): () => Promise<SlotOutcome[]> {
  const dispatcher = new Dispatcher(deps);
  return () => dispatcher.tick();
}
