import { describe, expect, it } from 'vitest';
import {
  admit,
  deferDelayS,
  initialCircuit,
  transition,
  type CircuitEvent,
  type CircuitState,
} from '../../src/common/circuit-breaker.js';
import { classifyResponse } from '../../src/common/error-classifier.js';
import { defaults } from '../../src/common/config.js';

const t0 = new Date('2026-03-01T12:00:00.000Z');
const at = (seconds: number): Date => new Date(t0.getTime() + seconds * 1000);

const success = (owner = 'w1'): CircuitEvent => ({ type: 'SUCCESS', owner });
const failure = (owner = 'w1'): CircuitEvent => ({ type: 'FAILURE', owner });
const acquire = (owner: string): CircuitEvent => ({ type: 'ACQUIRE_PROBE', owner });

function apply(state: CircuitState, events: CircuitEvent[], now = t0): CircuitState {
  return events.reduce((s, e) => transition(s, e, now, defaults), state);
}

const closed = (): CircuitState => initialCircuit(defaults, t0);
const opened = (): CircuitState =>
  apply(
    closed(),
    Array.from({ length: 5 }, () => failure()),
  );
/** HALF_OPEN owned by `probe`, acquired at `openUntil` (t0 + 60 s). */
const halfOpen = (probe = 'probe'): CircuitState =>
  transition(opened(), acquire(probe), at(60), defaults);

describe('transition: CLOSED', () => {
  it('counts consecutive failures below the threshold', () => {
    const s = apply(closed(), [failure(), failure(), failure(), failure()]);
    expect(s).toMatchObject({ state: 'CLOSED', consecutiveFailures: 4, openUntil: null });
  });

  it('opens at the threshold with open_until = now + base cooldown', () => {
    expect(opened()).toMatchObject({
      state: 'OPEN',
      consecutiveFailures: 5,
      cooldownS: 60,
      openUntil: at(60),
      halfOpenOwner: null,
    });
  });

  it('resets the counter on success, so failures must be consecutive', () => {
    const s = apply(closed(), [failure(), failure(), failure(), failure(), success(), failure()]);
    expect(s).toMatchObject({ state: 'CLOSED', consecutiveFailures: 1 });
  });

  it('returns the same object when a success changes nothing', () => {
    const s = closed();
    expect(transition(s, success(), t0, defaults)).toBe(s);
  });

  it('ignores ACQUIRE_PROBE', () => {
    const s = closed();
    expect(transition(s, acquire('w1'), t0, defaults)).toBe(s);
  });

  it('honours a custom threshold', () => {
    const s = transition(closed(), failure(), t0, { ...defaults, cbFailureThreshold: 1 });
    expect(s.state).toBe('OPEN');
  });
});

describe('transition: OPEN', () => {
  it('refuses the probe before open_until', () => {
    const s = opened();
    expect(transition(s, acquire('w1'), at(59), defaults)).toBe(s);
  });

  it('moves to HALF_OPEN with an owner at or after open_until', () => {
    expect(halfOpen('w1')).toMatchObject({
      state: 'HALF_OPEN',
      halfOpenOwner: 'w1',
      updatedAt: at(60),
    });
  });

  it('ignores late results of calls that started before it opened', () => {
    const s = opened();
    expect(transition(s, success(), at(10), defaults)).toBe(s);
    expect(transition(s, failure(), at(10), defaults)).toBe(s);
  });
});

describe('transition: HALF_OPEN', () => {
  it('closes and resets the cooldown to base when the probe succeeds', () => {
    const s = transition(halfOpen('w1'), success('w1'), at(61), defaults);
    expect(s).toEqual({
      state: 'CLOSED',
      consecutiveFailures: 0,
      cooldownS: 60,
      openUntil: null,
      halfOpenOwner: null,
      updatedAt: at(61),
    });
  });

  it('reopens with a doubled cooldown when the probe fails', () => {
    const s = transition(halfOpen('w1'), failure('w1'), at(61), defaults);
    expect(s).toMatchObject({
      state: 'OPEN',
      cooldownS: 120,
      openUntil: at(61 + 120),
      halfOpenOwner: null,
    });
  });

  it('doubles on every failed probe up to cbMaxCooldownS (900)', () => {
    let s = opened();
    let now = 0;
    const cooldowns: number[] = [];
    for (let i = 0; i < 6; i++) {
      now = (s.openUntil?.getTime() ?? 0) / 1000 - t0.getTime() / 1000;
      s = transition(s, acquire('w1'), at(now), defaults);
      s = transition(s, failure('w1'), at(now), defaults);
      cooldowns.push(s.cooldownS);
    }
    expect(cooldowns).toEqual([120, 240, 480, 900, 900, 900]);
    expect(s.openUntil).toEqual(at(now + 900));
  });

  it('only the owner can close or reopen it', () => {
    const s = halfOpen('w1');
    expect(transition(s, success('w2'), at(61), defaults)).toBe(s);
    expect(transition(s, failure('w2'), at(61), defaults)).toBe(s);
  });

  it('a second ACQUIRE_PROBE loses while the owner is alive', () => {
    const s = halfOpen('w1');
    expect(transition(s, acquire('w2'), at(61), defaults)).toBe(s);
  });

  it('a lost owner (no report within staleAfterS) is taken over', () => {
    const s = transition(halfOpen('w1'), acquire('w2'), at(60 + 360), defaults);
    expect(s).toMatchObject({ state: 'HALF_OPEN', halfOpenOwner: 'w2', updatedAt: at(420) });
  });

  it('the owner re-acquiring is a no-op', () => {
    const s = halfOpen('w1');
    expect(transition(s, acquire('w1'), at(61), defaults)).toBe(s);
  });

  it('closing after a doubled cooldown goes back to base', () => {
    let s = transition(halfOpen('w1'), failure('w1'), at(61), defaults);
    s = transition(s, acquire('w2'), at(181), defaults);
    s = transition(s, success('w2'), at(182), defaults);
    expect(s).toMatchObject({ state: 'CLOSED', cooldownS: 60 });
    expect(
      apply(
        s,
        Array.from({ length: 5 }, () => failure()),
        at(200),
      ).cooldownS,
    ).toBe(60);
  });
});

describe('race for HALF_OPEN', () => {
  it('only one of several Workers that read the same expired OPEN row wins', () => {
    // The adapter persists `next` only if the row is still the one it read (compare-and-swap).
    const snapshot = opened();
    let row = snapshot;
    const now = at(60);
    const owners = ['w1', 'w2', 'w3'];
    for (const owner of owners) {
      expect(admit(snapshot, owner, now, defaults)).toEqual({ kind: 'PROBE' });
    }
    const winners: string[] = [];
    for (const owner of owners) {
      const next = transition(snapshot, acquire(owner), now, defaults);
      if (next !== snapshot && row === snapshot) {
        row = next;
        winners.push(owner);
      }
    }
    expect(winners).toEqual(['w1']);
    expect(row.halfOpenOwner).toBe('w1');
    // A loser that re-reads the row computes no change.
    expect(transition(row, acquire('w2'), now, defaults)).toBe(row);
    expect(admit(row, 'w2', now, defaults)).toMatchObject({ kind: 'DEFER' });
  });
});

describe('admit', () => {
  it('allows calls for an unknown provider (no row = CLOSED)', () => {
    expect(admit(undefined, 'w1', t0, defaults)).toEqual({ kind: 'ALLOW' });
  });

  it('allows calls while CLOSED', () => {
    expect(admit(closed(), 'w1', t0, defaults)).toEqual({ kind: 'ALLOW' });
  });

  it('defers until open_until while OPEN', () => {
    expect(admit(opened(), 'w1', at(30), defaults)).toEqual({ kind: 'DEFER', until: at(60) });
  });

  it('asks for a probe once OPEN has expired', () => {
    expect(admit(opened(), 'w1', at(60), defaults)).toEqual({ kind: 'PROBE' });
  });

  it('lets the HALF_OPEN owner probe and defers everyone else by a base cooldown', () => {
    const s = halfOpen('w1');
    expect(admit(s, 'w1', at(61), defaults)).toEqual({ kind: 'PROBE' });
    expect(admit(s, 'w2', at(61), defaults)).toEqual({ kind: 'DEFER', until: at(121) });
  });

  it('asks for a probe when the HALF_OPEN owner is lost', () => {
    expect(admit(halfOpen('w1'), 'w2', at(60 + 360), defaults)).toEqual({ kind: 'PROBE' });
  });
});

describe('non-retryable errors', () => {
  it('4xx do not count: the Worker only reports RETRYABLE outcomes to the breaker', () => {
    let s = closed();
    for (const status of [400, 401, 403, 404, 409, 422, 503, 503]) {
      if (classifyResponse({ status }, t0).kind === 'RETRYABLE') {
        s = transition(s, failure(), t0, defaults);
      }
    }
    expect(s).toMatchObject({ state: 'CLOSED', consecutiveFailures: 2 });
  });
});

describe('deferDelayS', () => {
  it('is the remaining open time plus 0..30 s of jitter', () => {
    expect(deferDelayS(at(60), t0, defaults, () => 0)).toBe(60);
    expect(deferDelayS(at(60), t0, defaults, () => 1 - Number.EPSILON)).toBe(90);
  });

  it('is capped at maxDelayS', () => {
    expect(deferDelayS(at(3600), t0, defaults, () => 0)).toBe(900);
  });

  it('never goes negative when open_until is in the past', () => {
    expect(deferDelayS(at(-10), t0, defaults, () => 0)).toBe(0);
  });
});
