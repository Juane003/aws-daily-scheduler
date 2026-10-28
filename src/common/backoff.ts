import type { Config } from './config.js';

/** Source of randomness in [0, 1). Injectable so tests can pin the jitter. */
export type Random = () => number;

/**
 * Exponential backoff with full jitter (CLAUDE.md §6.4): `random(0, min(maxDelay, base × 2^(n-1)))`.
 * `attempt` is the 1-based number of the attempt that is being scheduled. Returns whole seconds,
 * because SQS `DelaySeconds` is an integer.
 */
export function backoffDelayS(
  attempt: number,
  config: Pick<Config, 'retryBaseS' | 'maxDelayS'>,
  random: Random = Math.random,
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`attempt must be a positive integer, got ${attempt}`);
  }
  // 2 ** large overflows to Infinity, which Math.min clamps to maxDelayS.
  const ceiling = Math.min(config.maxDelayS, config.retryBaseS * 2 ** (attempt - 1));
  // floor(r × (c + 1)) with r in [0, 1) is uniform over the integers 0..c.
  return Math.floor(random() * (Math.floor(ceiling) + 1));
}

/**
 * Delay for the next retry: honours `Retry-After` when the classifier extracted one (capped at
 * `maxDelayS`), otherwise falls back to {@link backoffDelayS}.
 */
export function retryDelayS(
  attempt: number,
  retryAfterS: number | undefined,
  config: Pick<Config, 'retryBaseS' | 'maxDelayS'>,
  random: Random = Math.random,
): number {
  if (retryAfterS !== undefined) {
    return Math.min(config.maxDelayS, Math.max(0, Math.ceil(retryAfterS)));
  }
  return backoffDelayS(attempt, config, random);
}
