import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../../src/adapters/memory/clock.js';
import { InMemoryLogger } from '../../src/adapters/memory/logger.js';
import { InMemoryMetrics } from '../../src/adapters/memory/metrics.js';
import { InMemoryRepository } from '../../src/adapters/memory/repository.js';
import { initialCircuit, transition, type CircuitState } from '../../src/common/circuit-breaker.js';
import { defaults } from '../../src/common/config.js';
import { CIRCUIT_CAS_ATTEMPTS, ProviderCircuits } from '../../src/core/execute/circuit.js';

const t0 = new Date('2026-03-01T12:00:00Z');

/** A repository whose compare-and-set loses the race `losses` times before behaving normally. */
class RacyRepository extends InMemoryRepository {
  casCalls = 0;
  constructor(private losses: number) {
    super();
  }
  override compareAndSetCircuit(
    providerId: string,
    expected: CircuitState | undefined,
    next: CircuitState,
  ): Promise<boolean> {
    this.casCalls++;
    if (this.losses > 0) {
      this.losses--;
      return Promise.resolve(false);
    }
    return super.compareAndSetCircuit(providerId, expected, next);
  }
}

function setup(losses = 0) {
  const clock = new VirtualClock(t0);
  const repository = new RacyRepository(losses);
  const logger = new InMemoryLogger();
  const metrics = new InMemoryMetrics();
  const circuits = new ProviderCircuits({ repository, clock, logger, metrics, config: defaults });
  return { clock, repository, logger, metrics, circuits };
}

async function seedOpen(repository: InMemoryRepository): Promise<void> {
  let state = initialCircuit(defaults, t0);
  for (let i = 0; i < defaults.cbFailureThreshold; i++) {
    state = transition(state, { type: 'FAILURE', owner: 'x' }, t0, defaults);
  }
  await InMemoryRepository.prototype.compareAndSetCircuit.call(repository, 'p', undefined, state);
}

describe('ProviderCircuits', () => {
  it('allows an unknown provider without writing a row', async () => {
    const { circuits, repository } = setup();
    expect(await circuits.allow('p', 'job')).toEqual({ kind: 'ALLOW' });
    expect(await repository.getCircuit('p')).toBeUndefined();
  });

  it('re-reads and re-applies a failure after a lost race, so no failure is lost', async () => {
    const { circuits, repository } = setup(2);
    await circuits.recordFailure('p', 'a');
    expect(repository.casCalls).toBe(3);
    expect((await repository.getCircuit('p'))?.consecutiveFailures).toBe(1);
  });

  it('logs and gives up when every write loses', async () => {
    const { circuits, repository, logger } = setup(Number.POSITIVE_INFINITY);
    await circuits.recordFailure('p', 'a');
    expect(repository.casCalls).toBe(CIRCUIT_CAS_ATTEMPTS);
    expect(logger.find('circuit update lost every race')).toHaveLength(1);
  });

  it('defers when the probe race is lost every time', async () => {
    const { circuits, repository, clock } = setup(Number.POSITIVE_INFINITY);
    await seedOpen(repository);
    clock.advanceSeconds(60);
    expect(await circuits.allow('p', 'job')).toEqual({
      kind: 'DEFER',
      until: new Date(t0.getTime() + 120_000),
    });
  });

  it('keeps the probe for its owner without a write (redelivery of the probe job)', async () => {
    const { circuits, repository, clock, metrics } = setup();
    await seedOpen(repository);
    clock.advanceSeconds(60);
    expect((await circuits.allow('p', 'job')).kind).toBe('PROBE');
    const calls = repository.casCalls;
    expect((await circuits.allow('p', 'job')).kind).toBe('PROBE');
    expect(repository.casCalls).toBe(calls);
    expect(metrics.total('CircuitStateChange', { from: 'OPEN', to: 'HALF_OPEN' })).toBe(1);
  });

  it('does not write when an event changes nothing', async () => {
    const { circuits, repository } = setup();
    await circuits.recordSuccess('p', 'a');
    expect(repository.casCalls).toBe(0);
  });
});
