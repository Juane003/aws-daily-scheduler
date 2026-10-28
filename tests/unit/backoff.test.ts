import { describe, expect, it } from 'vitest';
import { backoffDelayS, retryDelayS } from '../../src/common/backoff.js';
import { defaults } from '../../src/common/config.js';

const almostOne = 1 - Number.EPSILON;

describe('backoffDelayS', () => {
  it('grows as base × 2^(n-1) at the top of the jitter range', () => {
    const ceilings = [1, 2, 3, 4, 5, 6].map((n) => backoffDelayS(n, defaults, () => almostOne));
    expect(ceilings).toEqual([10, 20, 40, 80, 160, 320]);
  });

  it('never exceeds maxDelayS (900), even for huge attempts', () => {
    expect(backoffDelayS(7, defaults, () => almostOne)).toBe(640);
    expect(backoffDelayS(8, defaults, () => almostOne)).toBe(900);
    expect(backoffDelayS(2000, defaults, () => almostOne)).toBe(900);
  });

  it('uses full jitter: 0 at the bottom of the range', () => {
    expect(backoffDelayS(8, defaults, () => 0)).toBe(0);
  });

  it('stays within [0, ceiling] and returns integers with real randomness', () => {
    for (let n = 1; n <= 12; n++) {
      const ceiling = Math.min(900, 10 * 2 ** (n - 1));
      for (let i = 0; i < 200; i++) {
        const d = backoffDelayS(n, defaults);
        expect(Number.isInteger(d)).toBe(true);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it('rejects non-positive or fractional attempts', () => {
    expect(() => backoffDelayS(0, defaults)).toThrow(RangeError);
    expect(() => backoffDelayS(1.5, defaults)).toThrow(RangeError);
  });
});

describe('retryDelayS', () => {
  it('honours Retry-After instead of the backoff', () => {
    expect(retryDelayS(1, 120, defaults, () => 0)).toBe(120);
  });

  it('caps Retry-After at maxDelayS and rounds it up to whole seconds', () => {
    expect(retryDelayS(1, 3600, defaults)).toBe(900);
    expect(retryDelayS(1, 1.2, defaults)).toBe(2);
  });

  it('falls back to the backoff without Retry-After', () => {
    expect(retryDelayS(3, undefined, defaults, () => almostOne)).toBe(40);
  });
});
