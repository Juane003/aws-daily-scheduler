import { describe, expect, it } from 'vitest';
import { chunk, mapLimit } from '../../src/common/concurrency.js';
import { addDays, businessDate, minuteOfDay } from '../../src/common/time.js';

describe('business day', () => {
  it('maps a UTC instant to its minute and date', () => {
    const now = new Date('2026-03-01T23:59:59.999Z');
    expect(minuteOfDay(now, 'UTC')).toBe(1439);
    expect(businessDate(now, 'UTC')).toBe('2026-03-01');
    expect(minuteOfDay(new Date('2026-03-02T00:00:00Z'), 'UTC')).toBe(0);
  });

  it('uses the business time zone', () => {
    const now = new Date('2026-03-02T01:30:00Z');
    expect(minuteOfDay(now, 'America/Argentina/Buenos_Aires')).toBe(22 * 60 + 30);
    expect(businessDate(now, 'America/Argentina/Buenos_Aires')).toBe('2026-03-01');
    expect(minuteOfDay(new Date('2026-03-02T03:00:00Z'), 'America/Argentina/Buenos_Aires')).toBe(0);
  });

  it('adds days across months, years and leap days', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(() => addDays('nope', 1)).toThrow(RangeError);
  });
});

describe('concurrency helpers', () => {
  it('mapLimit keeps order and never exceeds the limit', async () => {
    let active = 0;
    let peak = 0;
    const results = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, (7 - n) % 3));
      active--;
      return n * 10;
    });
    expect(results).toEqual([10, 20, 30, 40, 50, 60, 70]);
    expect(peak).toBe(3);
    expect(await mapLimit([], 3, () => Promise.resolve(1))).toEqual([]);
    await expect(mapLimit([1], 0, () => Promise.resolve(1))).rejects.toThrow(RangeError);
  });

  it('chunk splits into fixed-size pieces', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 10)).toEqual([]);
    expect(() => chunk([1], 0)).toThrow(RangeError);
  });
});
