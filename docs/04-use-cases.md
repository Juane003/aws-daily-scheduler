# Stage 4 — Use cases

**Requirements:** R1, R2, R3, R4, R5 · **Depends on:** 3 · **CLAUDE.md:** §5, §7

## Goal

The four use cases, tested end-to-end with in-memory adapters, `FixedClock` and `FakeInternalApi`. After this stage the whole system works in memory.

## Files

```
src/application/usecases/
  ProcessJob.ts          FIFO worker logic
  RequeueJob.ts          retry queue logic
  DispatchTick.ts        per-minute dispatcher
  ReconcileStaleJobs.ts  stale + not-enqueued recovery
```

Each use case is a class whose constructor receives its ports and policies, with one `execute(...)` method returning a small result union (e.g. `{ kind: 'skipped' } | { kind: 'processed', status }`), so handlers can log/translate without business logic.

## Order of implementation

1. **`ProcessJob`** (core of R3, R4) — steps 1–6 of §5. Missing or inactive registry → DEAD `registry_inactive`, no API call, no notify. Always returns normally (ACK); retries only via `RetryScheduler`, with `delayFor(attempt, outcome.retryAfter)`.
2. **`RequeueJob`** — `findById` → RETRY_SCHEDULED → PENDING → `save` → `enqueue` → `markEnqueued`.
3. **`DispatchTick`** (R1, R2) — current window + every incomplete window from start of day; page through registries; `createIfAbsent` (`createdAt = now`) → `enqueue` → `markEnqueued` (only jobs actually sent) → `complete`; do not complete on partial enqueue failure.
4. **`ReconcileStaleJobs`** — `findStale` → `reclaimStale` → `save` → `enqueue` → `markEnqueued`; then `findPendingNotEnqueued` → `enqueue` → `markEnqueued`. Paginated by `limit`, never the whole day in memory.

## Design notes

- `ProcessJob` needs `businessDate`/`now` only from `Clock`.
- `ConcurrencyConflict` on `save` in `ProcessJob` means another actor (reconciler) changed the job; log and ACK — do not retry the call.
- R5 is guaranteed by infrastructure (FIFO group per provider); at this layer the use cases must simply never fan out a provider's jobs outside `JobQueue`.

## Tests (`tests/application/`) — required scenarios from §7

- [ ] Duplicate message → `tryAcquire` returns null, API not called.
- [ ] Transient failures until exhausted → DEAD + `DeadLetterNotifier.notify`.
- [ ] Permanent failure → DEAD, no `RetryScheduler.schedule`.
- [ ] Transient then success → SUCCEEDED, result stored, attempts incremented correctly.
- [ ] `retryAfter` from the API is passed through to `RetryScheduler`.
- [ ] Worker dies in IN_PROGRESS → `ReconcileStaleJobs` reclaims it after the lease (advance `FixedClock`), with `attempt.next()`.
- [ ] Missed tick → next `DispatchTick` dispatches the missing window(s).
- [ ] Partial `enqueue` failure → window not COMPLETED; reconciliation re-enqueues the PENDING jobs.
- [ ] Crash between `enqueue` and `markEnqueued` → reconciliation re-enqueues; the job runs once.
- [ ] Registry deleted or deactivated after dispatch → DEAD `registry_inactive`, no API call, no notify.
- [ ] `Retry-After` larger than `maxDelay` → delay capped at `maxDelay`.
- [ ] Running `DispatchTick` twice for the same slot creates no duplicate jobs (R1).
- [ ] Registry inactive on the date is not dispatched.

## Definition of done

- [ ] All scenarios green with in-memory adapters only.
- [ ] No `if` that depends on infrastructure concepts (status codes, receipt handles) in use cases.

## Decisions

_(record here)_
