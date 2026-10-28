import { describe, expect, it } from 'vitest';
import { computeSlot } from '../../src/common/slot.js';
import { createRng, generateRegistries, providerName } from '../../src/simulation/registries.js';

describe('generateRegistries', () => {
  it('is reproducible for the same seed', () => {
    const a = [...generateRegistries({ rows: 100, providers: 7, seed: 3 })];
    const b = [...generateRegistries({ rows: 100, providers: 7, seed: 3 })];
    expect(a).toEqual(b);
  });

  it('produces sequential ids with the D1 slot', () => {
    const rows = [...generateRegistries({ rows: 50, providers: 5 })];
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 50 }, (_, i) => String(i + 1)));
    for (const r of rows) expect(r.slot).toBe(computeSlot(r.id));
  });

  it('assigns roughly hotProviderShare of rows to the hot provider', () => {
    const rows = [...generateRegistries({ rows: 20_000, providers: 100, hotProviderShare: 0.2 })];
    const hot = rows.filter((r) => r.providerId === providerName(0)).length / rows.length;
    expect(hot).toBeGreaterThan(0.19);
    expect(hot).toBeLessThan(0.22);
  });

  it.each([
    [{ rows: -1, providers: 1 }],
    [{ rows: 1, providers: 0 }],
    [{ rows: 1, providers: 1, hotProviderShare: 1.5 }],
  ])('rejects invalid options %j', (opts) => {
    expect(() => [...generateRegistries(opts)]).toThrow(RangeError);
  });
});

describe('createRng', () => {
  it('returns values in [0, 1)', () => {
    const rng = createRng(42);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
