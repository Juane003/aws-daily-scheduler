import type { VirtualClock } from '../adapters/memory/clock.js';
import { MinHeap } from '../adapters/memory/collections.js';

/**
 * `setTimeout` on the virtual clock. `sleep` returns a promise that resolves when the harness
 * advances the clock past its due time and calls {@link fireDue}. This is what lets simulated API
 * latency overlap across Worker invocations without any real waiting.
 */
export class VirtualTimers {
  private readonly heap = new MinHeap<{ atMs: number; order: number; resolve: () => void }>(
    (a, b) => (a.atMs === b.atMs ? a.order < b.order : a.atMs < b.atMs),
  );
  private order = 0;

  constructor(private readonly clock: VirtualClock) {}

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.heap.push({
        atMs: this.clock.now().getTime() + Math.max(0, ms),
        order: this.order++,
        resolve,
      });
    });
  }

  /** Due time of the earliest pending sleep. */
  nextAt(): number | undefined {
    return this.heap.peek()?.atMs;
  }

  get pending(): number {
    return this.heap.size;
  }

  /** Resolves every sleep due at or before now, in due order. */
  fireDue(): number {
    const nowMs = this.clock.now().getTime();
    let fired = 0;
    for (
      let next = this.heap.peek();
      next !== undefined && next.atMs <= nowMs;
      next = this.heap.peek()
    ) {
      this.heap.pop();
      next.resolve();
      fired++;
    }
    return fired;
  }
}
