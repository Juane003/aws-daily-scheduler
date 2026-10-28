import type { Clock } from '../../core/ports.js';

/**
 * Virtual clock: time only moves when the test or the simulation advances it, so a full day runs
 * in seconds and every run is deterministic. It never goes backwards.
 */
export class VirtualClock implements Clock {
  private ms: number;

  constructor(start: Date | string) {
    this.ms = new Date(start).getTime();
    if (Number.isNaN(this.ms)) throw new RangeError(`invalid start time: ${String(start)}`);
  }

  now(): Date {
    return new Date(this.ms);
  }

  advanceMs(ms: number): Date {
    if (!(ms >= 0)) throw new RangeError(`cannot advance by ${ms} ms`);
    this.ms += ms;
    return this.now();
  }

  advanceSeconds(seconds: number): Date {
    return this.advanceMs(seconds * 1000);
  }

  /** Moves to `date`; a date in the past is an error. */
  advanceTo(date: Date): Date {
    return this.advanceMs(date.getTime() - this.ms);
  }
}
