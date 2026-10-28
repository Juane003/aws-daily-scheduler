import { createHash } from 'node:crypto';

/** Minutes in a day: the size of the slot wheel (D1). */
export const SLOTS_PER_DAY = 1440;

/**
 * D1: `slot = uint32(sha256(registryId)[0..4]) % 1440`.
 * Stable across runs and deployments, uniform across ids. Persisted in `registries.slot`.
 */
export function computeSlot(registryId: string): number {
  const digest = createHash('sha256').update(registryId, 'utf8').digest();
  return digest.readUInt32BE(0) % SLOTS_PER_DAY;
}
