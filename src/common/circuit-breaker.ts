import type { Random } from './backoff.js';
import type { Config } from './config.js';

/**
 * Per-provider circuit breaker (D8, CLAUDE.md §6.3). This module is the pure part: `admit` decides
 * what a Worker may do and `transition` computes the next row of `provider_circuits`. The adapter
 * persists `next` with an update conditioned on the row it read, so concurrent Workers race on
 * that condition and only one wins (e.g. the `HALF_OPEN` probe).
 */

export type CircuitStateName = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/** Mirrors a `provider_circuits` row. */
export interface CircuitState {
  state: CircuitStateName;
  consecutiveFailures: number;
  cooldownS: number;
  /** Set while `OPEN`; kept during `HALF_OPEN` for observability. */
  openUntil: Date | null;
  /** Worker that holds the `HALF_OPEN` probe. */
  halfOpenOwner: string | null;
  updatedAt: Date;
}

export type CircuitConfig = Pick<
  Config,
  'cbFailureThreshold' | 'cbBaseCooldownS' | 'cbMaxCooldownS' | 'staleAfterS'
>;

/**
 * - `ACQUIRE_PROBE`: take the `HALF_OPEN` slot (after `admit` returned `PROBE`).
 * - `SUCCESS` / `FAILURE`: result of a call. Only retryable failures are reported: 4xx do not
 *   reach the breaker.
 */
export type CircuitEvent =
  | { type: 'ACQUIRE_PROBE'; owner: string }
  | { type: 'SUCCESS'; owner: string }
  | { type: 'FAILURE'; owner: string };

export type Admission =
  | { kind: 'ALLOW' }
  /** Call allowed as the single test call; the caller must win `ACQUIRE_PROBE` first. */
  | { kind: 'PROBE' }
  /** Do not call the provider before `until`. */
  | { kind: 'DEFER'; until: Date };

/** A provider without a row is `CLOSED` (the row is created with an upsert). */
export function initialCircuit(config: CircuitConfig, now: Date): CircuitState {
  return {
    state: 'CLOSED',
    consecutiveFailures: 0,
    cooldownS: config.cbBaseCooldownS,
    openUntil: null,
    halfOpenOwner: null,
    updatedAt: now,
  };
}

export function admit(
  circuit: CircuitState | undefined,
  owner: string,
  now: Date,
  config: CircuitConfig,
): Admission {
  if (circuit === undefined) return { kind: 'ALLOW' };
  switch (circuit.state) {
    case 'CLOSED':
      return { kind: 'ALLOW' };
    case 'OPEN':
      if (circuit.openUntil !== null && now < circuit.openUntil) {
        return { kind: 'DEFER', until: circuit.openUntil };
      }
      return { kind: 'PROBE' };
    case 'HALF_OPEN':
      if (circuit.halfOpenOwner === owner || isProbeLost(circuit, now, config)) {
        return { kind: 'PROBE' };
      }
      // The probe usually resolves within one HTTP timeout; check again after a base cooldown.
      return { kind: 'DEFER', until: addSeconds(now, config.cbBaseCooldownS) };
  }
}

/** Returns `circuit` itself when the event does not change anything. */
export function transition(
  circuit: CircuitState,
  event: CircuitEvent,
  now: Date,
  config: CircuitConfig,
): CircuitState {
  switch (event.type) {
    case 'ACQUIRE_PROBE':
      return acquireProbe(circuit, event.owner, now, config);
    case 'SUCCESS':
      return onSuccess(circuit, event.owner, now, config);
    case 'FAILURE':
      return onFailure(circuit, event.owner, now, config);
  }
}

/**
 * Seconds to defer a job while the provider is unavailable:
 * `min(maxDelay, until - now + jitter(0..30 s))`. The jitter spreads the deferred jobs so they do
 * not all come back in the same second.
 */
export function deferDelayS(
  until: Date,
  now: Date,
  config: Pick<Config, 'maxDelayS'>,
  random: Random = Math.random,
): number {
  const remaining = Math.max(0, Math.ceil((until.getTime() - now.getTime()) / 1000));
  return Math.min(config.maxDelayS, remaining + Math.floor(random() * 31));
}

function acquireProbe(
  circuit: CircuitState,
  owner: string,
  now: Date,
  config: CircuitConfig,
): CircuitState {
  const openExpired =
    circuit.state === 'OPEN' && (circuit.openUntil === null || now >= circuit.openUntil);
  // A lost owner is equivalent to an expired OPEN row, so the new owner takes over directly.
  const takeover =
    circuit.state === 'HALF_OPEN' &&
    circuit.halfOpenOwner !== owner &&
    isProbeLost(circuit, now, config);
  if (!openExpired && !takeover) return circuit;
  return { ...circuit, state: 'HALF_OPEN', halfOpenOwner: owner, updatedAt: now };
}

function onSuccess(
  circuit: CircuitState,
  owner: string,
  now: Date,
  config: CircuitConfig,
): CircuitState {
  if (circuit.state === 'CLOSED') {
    if (circuit.consecutiveFailures === 0) return circuit;
    return { ...circuit, consecutiveFailures: 0, updatedAt: now };
  }
  if (circuit.state === 'HALF_OPEN' && circuit.halfOpenOwner === owner) {
    return initialCircuit(config, now);
  }
  // OPEN, or HALF_OPEN owned by someone else: a call that started before the circuit opened.
  // Only the probe may close the circuit.
  return circuit;
}

function onFailure(
  circuit: CircuitState,
  owner: string,
  now: Date,
  config: CircuitConfig,
): CircuitState {
  if (circuit.state === 'CLOSED') {
    const consecutiveFailures = circuit.consecutiveFailures + 1;
    if (consecutiveFailures < config.cbFailureThreshold) {
      return { ...circuit, consecutiveFailures, updatedAt: now };
    }
    return open(circuit, consecutiveFailures, circuit.cooldownS, now);
  }
  if (circuit.state === 'HALF_OPEN' && circuit.halfOpenOwner === owner) {
    const cooldownS = Math.min(2 * circuit.cooldownS, config.cbMaxCooldownS);
    return open(circuit, circuit.consecutiveFailures + 1, cooldownS, now);
  }
  // Already OPEN, or a late failure while someone else probes: nothing new to learn.
  return circuit;
}

function open(
  circuit: CircuitState,
  consecutiveFailures: number,
  cooldownS: number,
  now: Date,
): CircuitState {
  return {
    ...circuit,
    state: 'OPEN',
    consecutiveFailures,
    cooldownS,
    openUntil: addSeconds(now, cooldownS),
    halfOpenOwner: null,
    updatedAt: now,
  };
}

/** A `HALF_OPEN` owner that does not report within `staleAfterS` is considered lost. */
function isProbeLost(circuit: CircuitState, now: Date, config: CircuitConfig): boolean {
  return now.getTime() - circuit.updatedAt.getTime() >= config.staleAfterS * 1000;
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}
