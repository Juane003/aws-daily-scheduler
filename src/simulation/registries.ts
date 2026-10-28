import { computeSlot } from '../common/slot.js';

/**
 * Synthetic registries for seeds and the in-memory simulation.
 * Deterministic for a given seed so runs are reproducible.
 */

export interface RegistryRow {
  id: string;
  providerId: string;
  endpoint: string;
  httpMethod: 'POST';
  body: Record<string, unknown>;
  slot: number;
  enabled: boolean;
}

export interface GenerateOptions {
  rows: number;
  providers: number;
  /** Fraction of rows (0..1) assigned to the first provider, to model a hot provider. */
  hotProviderShare?: number;
  seed?: number;
}

/** mulberry32: tiny, fast, seedable PRNG. Not cryptographic; fine for fixtures. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function providerName(index: number): string {
  return `provider-${String(index + 1).padStart(5, '0')}`;
}

export function* generateRegistries(opts: GenerateOptions): Generator<RegistryRow> {
  const { rows, providers, hotProviderShare = 0, seed = 1 } = opts;
  if (!Number.isInteger(rows) || rows < 0)
    throw new RangeError('rows must be a non-negative integer');
  if (!Number.isInteger(providers) || providers < 1) {
    throw new RangeError('providers must be a positive integer');
  }
  if (hotProviderShare < 0 || hotProviderShare > 1) {
    throw new RangeError('hotProviderShare must be in [0, 1]');
  }
  const rng = createRng(seed);
  for (let i = 1; i <= rows; i++) {
    const id = String(i);
    const providerIndex = rng() < hotProviderShare ? 0 : Math.floor(rng() * providers) % providers;
    const providerId = providerName(providerIndex);
    yield {
      id,
      providerId,
      endpoint: `/providers/${providerId}/query`,
      httpMethod: 'POST',
      body: { registryId: id, query: 'daily' },
      slot: computeSlot(id),
      enabled: true,
    };
  }
}
