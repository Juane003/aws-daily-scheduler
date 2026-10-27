# Stage 2 — Domain policies

**Requirements:** R2, R4 · **Depends on:** 1 · **CLAUDE.md:** §3

## Goal

Three pure policies with all their inputs injected, so they are fully deterministic under test.

## Files

```
src/domain/policies/
  RetryPolicy.ts      maxAttempts, maxDelay, exhausted(attempt), delayFor(attempt, retryAfter?)
  SlotCalculator.ts   slotFor(registryId) → Slot
  StalePolicy.ts      isStale(job, now)
  Random.ts           type Random = () => number   // in [0, 1)
```

## Design notes

### `RetryPolicy`
- Config: `maxAttempts`, `baseDelay`, `maxDelay`, injected `Random`.
- `exhausted(attempt) = attempt.value >= maxAttempts`.
- `delayFor(attempt)`: capped exponential backoff with jitter, e.g. full jitter `random() * min(maxDelay, base * 2^(attempt-1))`.
- If `retryAfter` is present, it wins (still capped at `maxDelay`).
- `maxDelay` is plain configuration; the domain does not know why it has a limit. The composition root (stage 8) sets it to 900 s, the SQS `DelaySeconds` limit.

### `SlotCalculator`
- `uint32(sha256(registryId)[0..4]) % 1440`, big-endian read of the first 4 bytes.
- SHA-256 is pure but comes from `node:crypto`. Either allow `node:crypto` explicitly in the domain lint rule, or inject a `Hasher` function. Decide and record it below.
- The slot is computed once when a registry row is created and persisted (R2); the calculator is not called on every tick.

### `StalePolicy`
- `isStale(job, now) = job.status === 'IN_PROGRESS' && job.leaseUntil < now`.
- Holds the lease duration (≥ 30 min) so `ProcessJob` and the reconciler use the same value. Validate `lease >= 30 min` at construction.

## Tests (`tests/domain/policies/`)

- `RetryPolicy`: fixed RNG (0, 0.5, 0.999…) → exact delays; growth per attempt; cap reached; `retryAfter` honoured and capped; `exhausted` at the boundary.
- `SlotCalculator`: determinism (same id → same slot, known vectors); always in `[0, 1439]`; uniformity — 1M synthetic ids, chi-square over 1440 buckets below the 99.9 % critical value (keep the test under a few seconds).
- `StalePolicy`: lease in the past / exactly now / future; non-IN_PROGRESS never stale; lease < 30 min rejected.

## Definition of done

- [ ] Policies have no hidden dependencies (no `Math.random`, no clock).
- [ ] `Job.failTransient` / `Job.reclaimStale` tests from stage 1 run against the real policies too.

## Decisions

_(record here: how SHA-256 is provided to the domain)_
