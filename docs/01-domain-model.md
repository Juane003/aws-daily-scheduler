# Stage 1 — Domain model

**Requirements:** R1, R3, R4 · **Depends on:** 0 · **CLAUDE.md:** §2

## Goal

The pure domain: value objects, `Registry`, the `Job` state machine and the `ApiOutcome` union. No I/O, no clock, no SDKs.

## Files

```
src/domain/model/
  JobId.ts          registryId + "#" + YYYY-MM-DD; create() + parse()
  ProviderId.ts     non-empty
  RegistryId.ts     non-empty (the id of a registry row)
  Attempt.ts        integer ≥ 1, next(), immutable
  Slot.ts           integer in [0, 1439]
  BusinessDate.ts   UTC date; fromInstant(instant), toString() = YYYY-MM-DD
  Instant.ts        epoch-millis wrapper used by Clock and leases (plus Duration)
  Registry.ts       id, providerId, endpoint, body, slot, activeFrom, inactiveFrom?, enabled; isActiveOn(date)
  JobStatus.ts      'PENDING' | 'IN_PROGRESS' | 'RETRY_SCHEDULED' | 'SUCCEEDED' | 'DEAD'
  ExecutionResult.ts  stored result of a successful call (payload + completedAt)
  ApiOutcome.ts     Success | TransientFailure(reason, retryAfter?) | PermanentFailure(reason)
  Job.ts            state machine
src/domain/errors/
  DomainError.ts         (exists)
  InvalidTransition.ts   from-status, method name
  InvalidValue.ts        thrown by VO factories
```

## Design notes

- **VOs:** private constructor + static `create(...)` that validates and throws `InvalidValue`; or branded types with a factory. Never raw `string` where a VO exists.
- **`JobId`** is what makes R1 hold: one job per registry row per business date. `JobId.for(registryId, businessDate)`.
- **`Job`** is mutable inside its methods only through the transitions in the §2 table; every method checks the source status and throws `InvalidTransition`. Expose a `snapshot()` / read-only getters for persistence; rehydration through a static `Job.restore(props)` that validates the invariants.
- Fields include `createdAt` and `enqueuedAt?`. `markEnqueued(at)` is PENDING → PENDING; `requeue()` and `reclaimStale()` clear `enqueuedAt` so a new attempt is never mistaken for an enqueued one.
- `failTransient(error, retryPolicy)` needs only `retryPolicy.exhausted(attempt)`; type it against a narrow interface so stage 1 does not depend on stage 2's implementation.
- `reclaimStale(now, stalePolicy)` likewise takes a narrow `isStale(job, now)` interface.
- `lastError` is a domain string/reason, never an SDK error or HTTP status.

## Tests (`tests/domain/model/`)

- Each VO: valid values, every invalid boundary (`Attempt` 0, `Slot` -1 / 1440, empty ids, malformed dates).
- `Registry.isActiveOn`: before `activeFrom`, on `activeFrom`, on `inactiveFrom` (inactive), disabled.
- `Job`, every valid transition in the §2 table and its effect (`leaseUntil` set/cleared, `attempt.next()`, `result` stored).
- `Job`, every invalid transition throws `InvalidTransition` — in particular nothing leaves SUCCEEDED or DEAD.
- Invariants: `attempt` never decreases; IN_PROGRESS always has `leaseUntil`; `Job.restore` rejects IN_PROGRESS without a lease.
- `failTransient` → DEAD when exhausted, RETRY_SCHEDULED otherwise.
- `markEnqueued` only from PENDING; `requeue` and `reclaimStale` reset `enqueuedAt` to null.

## Definition of done

- [ ] All files above, no imports outside `domain/`.
- [ ] 100 % branch coverage on `Job.ts` and the VOs.
- [ ] Exhaustive `switch` over `ApiOutcome` and `JobStatus` compiles with `assertNever`.

## Decisions

_(record here)_
