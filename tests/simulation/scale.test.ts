import { describe, expect, it } from 'vitest';
import { distribution, percentiles, runScaleSimulation } from '../../src/simulation/scale.js';

/**
 * Reduced scale simulation for `npm test` (the full 1M run is `npm run simulate`). A simulation on
 * a virtual clock, not a benchmark. The latency is high on purpose so that a hot provider with a
 * few thousand registries already exceeds its daily ceiling of 86 400 / latency.
 */
describe('scale simulation (reduced)', () => {
  it('spreads the day, keeps one call per provider and shows the hot provider above its ceiling', async () => {
    const rows = 20_000;
    const report = await runScaleSimulation({
      rows,
      providers: 50,
      hotProviderShare: 0.8,
      seed: 11,
      profile: { latencyMs: [8000, 9000], error5xxRate: 0.01, error4xxRate: 0.005 },
      esmMaxConcurrency: 100,
    });

    // Every job of the day ended, and only terminal statuses remain.
    const total = Object.values(report.statusCounts).reduce((a, b) => a + b, 0);
    expect(total).toBe(rows);
    expect(Object.keys(report.statusCounts).sort()).toEqual(
      ['FAILED_EXPIRED', 'FAILED_NON_RETRYABLE', 'SUCCEEDED'].sort(),
    );
    expect(report.previousDayCalls).toBe(0);
    expect(report.peakConcurrencyPerProvider).toBe(1);

    // The slot wheel spreads the dispatch over the 1 440 minutes.
    expect(report.dispatchedPerMinute.mean * 1440).toBeCloseTo(rows, 0);
    expect(report.dispatchedPerMinute.min).toBeGreaterThan(0);

    // The hot provider cannot finish: it is above 86 400 / 8.5 s ≈ 10 165 calls per day.
    const hot = report.hotProvider;
    expect(hot).toBeDefined();
    if (hot === undefined) return;
    expect(hot.rows).toBeGreaterThan(hot.dailyCeiling);
    expect(hot.callsInDay).toBeLessThanOrEqual(Math.ceil(hot.dailyCeiling * 1.01));
    expect(hot.succeededInDay).toBeLessThan(hot.dailyCeiling);
    expect(hot.expired).toBeGreaterThan(0);
    // The other providers are not affected by it.
    expect(report.providerLagS.p95).toBeLessThan(120);
  });
});

describe('report helpers', () => {
  it('computes distributions and percentiles', () => {
    expect(distribution([2, 4, 4, 4, 5, 5, 7, 9])).toEqual({ mean: 5, min: 2, max: 9, stdDev: 2 });
    expect(distribution([])).toEqual({ mean: 0, min: 0, max: 0, stdDev: 0 });
    expect(percentiles([5, 1, 3, 2, 4])).toEqual({ p50: 3, p95: 5, max: 5 });
    expect(percentiles([])).toEqual({ p50: 0, p95: 0, max: 0 });
  });
});
