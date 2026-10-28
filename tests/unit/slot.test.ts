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
});
