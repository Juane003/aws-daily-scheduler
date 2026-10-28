import {
  Reconciler,
  type ReconcileSummary,
  type ReconcilerDeps,
} from '../core/reconcile/reconciler.js';

/**
 * Reconciler Lambda — reference implementation, not deployed. In the target design EventBridge
 * Scheduler invokes it every hour (D10); here the simulation harness calls it.
 */
export function createReconcilerHandler(deps: ReconcilerDeps): () => Promise<ReconcileSummary> {
  const reconciler = new Reconciler(deps);
  return () => reconciler.run();
}
