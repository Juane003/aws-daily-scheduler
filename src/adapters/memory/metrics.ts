import type { Dimensions, Metrics } from '../../common/telemetry.js';

interface Series {
  name: string;
  dimensions: Dimensions;
  sum: number;
  values: number[];
}

/**
 * Accumulates counters and observations by name and dimensions. Queries match a series when its
 * dimensions include every requested one, so `total('JobsFailed')` sums all reasons and
 * `total('JobsFailed', { reason: 'EXPIRED' })` only one.
 */
export class InMemoryMetrics implements Metrics {
  private readonly counters = new Map<string, Series>();
  private readonly observations = new Map<string, Series>();

  count(name: string, dimensions: Dimensions = {}, value = 1): void {
    this.series(this.counters, name, dimensions).sum += value;
  }

  record(name: string, value: number, dimensions: Dimensions = {}): void {
    const series = this.series(this.observations, name, dimensions);
    series.sum += value;
    series.values.push(value);
  }

  total(name: string, dimensions: Dimensions = {}): number {
    let sum = 0;
    for (const s of matching(this.counters, name, dimensions)) sum += s.sum;
    return sum;
  }

  values(name: string, dimensions: Dimensions = {}): number[] {
    return [...matching(this.observations, name, dimensions)].flatMap((s) => s.values);
  }

  /** Dimension sets seen for a counter, e.g. every `CircuitStateChange{provider, from, to}`. */
  dimensionsOf(name: string): Dimensions[] {
    return [...matching(this.counters, name, {})].map((s) => s.dimensions);
  }

  private series(store: Map<string, Series>, name: string, dimensions: Dimensions): Series {
    const key = seriesKey(name, dimensions);
    let series = store.get(key);
    if (series === undefined) {
      series = { name, dimensions: { ...dimensions }, sum: 0, values: [] };
      store.set(key, series);
    }
    return series;
  }
}

function seriesKey(name: string, dimensions: Dimensions): string {
  const sorted = Object.keys(dimensions)
    .sort()
    .map((k) => [k, dimensions[k]]);
  return `${name}|${JSON.stringify(sorted)}`;
}

function* matching(
  store: Map<string, Series>,
  name: string,
  dimensions: Dimensions,
): Generator<Series> {
  for (const series of store.values()) {
    if (series.name !== name) continue;
    if (Object.entries(dimensions).every(([k, v]) => series.dimensions[k] === v)) yield series;
  }
}
