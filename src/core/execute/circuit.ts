import {
  admit,
  initialCircuit,
  transition,
  type Admission,
  type CircuitConfig,
  type CircuitEvent,
  type CircuitState,
} from '../../common/circuit-breaker.js';
import type { Logger, Metrics } from '../../common/telemetry.js';
import type { CircuitRepository, Clock } from '../ports.js';

/**
 * Persists the pure breaker (`common/circuit-breaker.ts`) in `provider_circuits` (D8). Every write
 * is a compare-and-set against the row that was read; on a lost race it re-reads and re-applies,
 * so concurrent failures are all counted and only one Worker acquires the `HALF_OPEN` probe.
 */

/** Re-reads after a lost compare-and-set before giving up. */
export const CIRCUIT_CAS_ATTEMPTS = 5;

export interface ProviderCircuitsDeps {
  repository: CircuitRepository;
  clock: Clock;
  logger: Logger;
  metrics: Metrics;
  config: CircuitConfig;
}

export class ProviderCircuits {
  constructor(private readonly deps: ProviderCircuitsDeps) {}

  /**
   * `ALLOW`, `PROBE` (this owner now holds the `HALF_OPEN` probe) or `DEFER`. A `PROBE` from the
   * pure `admit` becomes a `DEFER` when another Worker wins the race for the probe.
   */
  async allow(providerId: string, owner: string): Promise<Admission> {
    const { repository, clock, config } = this.deps;
    for (let i = 0; i < CIRCUIT_CAS_ATTEMPTS; i++) {
      const now = clock.now();
      const row = await repository.getCircuit(providerId);
      const admission = admit(row, owner, now, config);
      if (admission.kind !== 'PROBE' || row === undefined) return admission;
      const next = transition(row, { type: 'ACQUIRE_PROBE', owner }, now, config);
      // Already the owner (e.g. a redelivery of the probe job): nothing to write.
      if (next === row) return admission;
      if (await repository.compareAndSetCircuit(providerId, row, next)) {
        this.emit(providerId, row, next);
        return admission;
      }
    }
    return {
      kind: 'DEFER',
      until: new Date(clock.now().getTime() + config.cbBaseCooldownS * 1000),
    };
  }

  recordSuccess(providerId: string, owner: string): Promise<void> {
    return this.record(providerId, { type: 'SUCCESS', owner });
  }

  /** Only retryable failures are reported; 4xx never reach the breaker. */
  recordFailure(providerId: string, owner: string): Promise<void> {
    return this.record(providerId, { type: 'FAILURE', owner });
  }

  /**
   * Best effort: the API call already happened, so a breaker write that keeps losing races is
   * logged instead of failing the job (which would cause a redelivery and a second call).
   */
  private async record(providerId: string, event: CircuitEvent): Promise<void> {
    const { repository, clock, config, logger } = this.deps;
    for (let i = 0; i < CIRCUIT_CAS_ATTEMPTS; i++) {
      const now = clock.now();
      const row = await repository.getCircuit(providerId);
      const current = row ?? initialCircuit(config, now);
      const next = transition(current, event, now, config);
      if (next === current) return;
      if (await repository.compareAndSetCircuit(providerId, row, next)) {
        this.emit(providerId, current, next);
        return;
      }
    }
    logger.log('warn', 'circuit update lost every race', { providerId, event: event.type });
  }

  private emit(providerId: string, from: CircuitState, to: CircuitState): void {
    if (from.state === to.state && from.halfOpenOwner === to.halfOpenOwner) return;
    this.deps.metrics.count('CircuitStateChange', {
      provider: providerId,
      from: from.state,
      to: to.state,
    });
    this.deps.logger.log(to.state === 'OPEN' ? 'warn' : 'info', 'circuit state change', {
      providerId,
      from: from.state,
      to: to.state,
      consecutiveFailures: to.consecutiveFailures,
      cooldownS: to.cooldownS,
      openUntil: to.openUntil,
      halfOpenOwner: to.halfOpenOwner,
    });
  }
}
