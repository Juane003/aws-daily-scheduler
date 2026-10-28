import { describe, expect, it } from 'vitest';
import { computeSlot, SLOTS_PER_DAY } from '../../src/common/slot.js';

describe('computeSlot', () => {
  it('is deterministic', () => {
    expect(computeSlot('42')).toBe(computeSlot('42'));
  });

  it('matches a known vector (sha256("1") first 4 bytes = 0x6b86b273)', () => {
    expect(computeSlot('1')).toBe(0x6b86b273 % SLOTS_PER_DAY);
  });

  it('stays in 0..1439', () => {
    for (let i = 0; i < 10_000; i++) {
      const s = computeSlot(String(i));
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(SLOTS_PER_DAY);
    }
  });

  it('is uniform over 1M ids (chi-squared, p > 0.01)', () => {
    const n = 1_000_000;
    const counts = new Array<number>(SLOTS_PER_DAY).fill(0);
    for (let i = 1; i <= n; i++) {
      const s = computeSlot(String(i));
      counts[s] = (counts[s] ?? 0) + 1;
    }
    const expected = n / SLOTS_PER_DAY;
    const chi2 = counts.reduce((acc, c) => acc + (c - expected) ** 2 / expected, 0);

    // Wilson–Hilferty approximation of the 0.99 quantile of χ²(k), k = 1439 degrees of freedom.
    const k = SLOTS_PER_DAY - 1;
    const z99 = 2.326348;
    const critical = k * (1 - 2 / (9 * k) + z99 * Math.sqrt(2 / (9 * k))) ** 3;

    expect(critical).toBeCloseTo(1566.7, 1);
    expect(chi2).toBeLessThan(critical);
  });
});
