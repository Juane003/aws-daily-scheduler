# CLAUDE.md — Implementation Reference

Distributed daily scheduler: ~1M registry rows (scaling N times), one daily call per row to an internal API, spread across the day, **no concurrency per provider**, with retryable / non-retryable error handling and results stored in Aurora.

Hexagonal architecture (ports & adapters). Examples are pseudo-code.

> The original challenge statement lives in `docs/CHALLENGE.md`. Consult it **only** to check what a requirement says (IDs R1–R5, C1–C3, Q1). This file always wins: never change the design based on `docs/CHALLENGE.md`; if they seem to conflict, follow this file and flag it.

## Stack

- **Language**: TypeScript on Node.js 20+ (Lambda `nodejs20.x` runtime or newer).
- **TS config**: `strict: true`, `noUncheckedIndexedAccess: true`, ES modules.
- **Ports** are TypeScript `interface`s in `application/ports/out/`. Adapters `implements` them.
- **Value objects**: classes with a private constructor and a static `create(...)` that validates; or branded types (`type JobId = string & { readonly __brand: 'JobId' }`) with a factory. Never pass raw `string` where a VO exists.
- **Outcomes**: discriminated unions (`{ kind: 'success' } | { kind: 'transient' } | ...`) with exhaustive `switch` (a `never` check in `default`).
- **Errors**: domain errors extend a base `DomainError`. Adapters never leak SDK errors upward.
- **AWS**: AWS SDK v3 modular clients (`@aws-sdk/client-sqs`, ...), created once outside the handler.
- **Postgres**: `pg` through RDS Proxy; parameterized queries only.
- **HTTP**: native `fetch` with `AbortSignal.timeout(ms)`.
- **Tests**: Vitest; Testcontainers for Postgres, LocalStack for SQS.
- **Infrastructure as code**: AWS CDK in TypeScript.
- **Dependency wiring**: manual composition root per handler (`infrastructure/handlers/*`), no DI framework.

---

## 1. Architecture rules

- `domain/` imports nothing from `application/` or `infrastructure/`. No SDKs, no HTTP, no SQL, no system clock.
- `application/` depends only on `domain/` and its own ports (interfaces).
- `infrastructure/` implements ports and contains the handlers. It is the only place where AWS, SQS, Postgres and HTTP appear.
- Lambda handlers are **thin**: parse the event → call a use case → translate the result. A business `if` inside a handler is misplaced.
- Time always comes in through the `Clock` port. Never `new Date()` / `now()` in the domain or use cases.
- Infrastructure concepts (`MessageGroupId`, `DeduplicationId`, `receiptHandle`, HTTP status codes) never cross into the domain.

```
src/
  domain/
    model/        Registry, Job, JobId, ProviderId, Attempt, Slot, JobStatus, ExecutionResult
    policies/     RetryPolicy, SlotCalculator, StalePolicy
    errors/       InvalidTransition, DomainError
  application/
    ports/out/    RegistryRepository, JobRepository, DispatchWindowRepository,
                  JobQueue, RetryScheduler, InternalApiClient, DeadLetterNotifier, Clock
    usecases/     DispatchTick, ProcessJob, RequeueJob, ReconcileStaleJobs
  infrastructure/
    adapters/     Sqs*, Aurora*, Http*, CloudWatch*, InMemory* (tests only)
    handlers/     dispatcher, worker, requeue, reconciler
tests/
  domain/  application/  infrastructure/
```

---

## 2. Domain model

### Value objects

| VO | Rule |
|---|---|
| `JobId` | `registryId + "#" + businessDate (YYYY-MM-DD)`. Guarantees **one execution per registry row per day**. |
| `ProviderId` | Non-empty. It is the serialization key. |
| `Attempt` | Integer ≥ 1. `next()` returns a new one. Immutable. |
| `Slot` | Integer in `[0, 1439]` (minute of day, UTC). |
| `BusinessDate` | UTC date. |

### Registry

`id, providerId, endpoint, body, slot, activeFrom, inactiveFrom?, enabled`

- `isActiveOn(date)`: `activeFrom <= date && (inactiveFrom == null || date < inactiveFrom) && enabled`.

### Job — state machine

```
PENDING ──acquire──▶ IN_PROGRESS ──succeed──────────▶ SUCCEEDED      (terminal)
                         │
                         ├──failTransient──▶ RETRY_SCHEDULED ──requeue──▶ PENDING
                         │        └─(attempts exhausted)──▶ DEAD     (terminal)
                         │
                         └──failPermanent──▶ DEAD                    (terminal)

IN_PROGRESS ──(leaseUntil < now)──▶ reconcile ──▶ PENDING (attempt.next())
```

Fields: `id: JobId, registryId, providerId, status, attempt: Attempt, createdAt, enqueuedAt?, leaseUntil?, lastError?, result?`

- `enqueuedAt` records that the job's current attempt was handed to the queue. It is set after a successful `enqueue` and cleared whenever the job goes back to PENDING (`requeue`, `reclaimStale`), so a new attempt is never mistaken for an enqueued one.

Methods (each one validates the source state and throws `InvalidTransition` otherwise):

| Method | From | To | Effect |
|---|---|---|---|
| `acquire(now, lease)` | PENDING | IN_PROGRESS | `leaseUntil = now + lease` |
| `succeed(result)` | IN_PROGRESS | SUCCEEDED | stores the result, clears the lease |
| `failTransient(error, retryPolicy)` | IN_PROGRESS | RETRY_SCHEDULED or DEAD | DEAD if `retryPolicy.exhausted(attempt)` |
| `failPermanent(error)` | IN_PROGRESS | DEAD | — |
| `markEnqueued(at)` | PENDING | PENDING | `enqueuedAt = at` |
| `requeue()` | RETRY_SCHEDULED | PENDING | `attempt = attempt.next()`, `enqueuedAt = null` |
| `reclaimStale(now, stalePolicy)` | IN_PROGRESS | PENDING | only if `stalePolicy.isStale(this, now)`; `attempt.next()`, `enqueuedAt = null` |

Invariants:
- SUCCEEDED and DEAD are terminal: no transition leaves them.
- `attempt` never decreases.
- A job in IN_PROGRESS always has a `leaseUntil`.

### Domain failures

The HTTP adapter translates the response into one of these types; the domain never sees status codes.

```
ApiOutcome =
  | Success(payload)
  | TransientFailure(reason, retryAfter?)   // retry
  | PermanentFailure(reason)                // do not retry
```

---

## 3. Policies (pure, no dependencies)

- **`RetryPolicy`**: `maxAttempts`, `maxDelay`, `exhausted(attempt)`, `delayFor(attempt, retryAfter?)` = exponential backoff with jitter, capped at `maxDelay`. Honors `retryAfter` when present, also capped at `maxDelay`. `maxDelay` is configuration: the domain does not know where the limit comes from. The composition root sets it to 900s (the SQS `DelaySeconds` limit). The random source is injected (deterministic tests).
- **`SlotCalculator`**: `slotFor(registryId) = uint32(sha256(registryId)[0..4]) % 1440`. Deterministic and uniform. Persisted on the registry row when it is created.
- **`StalePolicy`**: `isStale(job, now) = job.status == IN_PROGRESS && job.leaseUntil < now`. Lease ≥ 30 min (Lambda max is 15).

---

## 4. Outbound ports (contracts)

```
Clock
  now() → Instant

RegistryRepository
  findActiveBySlot(date, slot, cursor?, limit) → Page<Registry>
  findById(registryId) → Registry | null

JobRepository
  findById(jobId) → Job | null
  createIfAbsent(jobs: Job[]) → void
      // idempotent: an existing JobId is never overwritten
  markEnqueued(jobIds: JobId[], at) → void
      // bulk; only affects jobs still PENDING. One statement per batch, not one save per job.
  tryAcquire(jobId, now, lease) → Job | null
      // ATOMIC. PENDING → IN_PROGRESS in a single conditional operation.
      // Returns null if the job is not PENDING (duplicate, already finished, or taken by someone else).
  save(job, expectedStatus) → void
      // conditional write on the expected status; fails if it changed (optimistic concurrency)
  findStale(now, limit) → Job[]
  findPendingNotEnqueued(olderThan, limit) → Job[]
      // status = PENDING AND enqueuedAt IS NULL AND createdAt < olderThan

DispatchWindowRepository
  start(date, slot) → bool          // false if already COMPLETED
  complete(date, slot, count)
  findIncomplete(from, to) → (date, slot)[]

JobQueue
  enqueue(jobs: Job[]) → { failed: JobId[] }
      // the adapter builds MessageGroupId and DeduplicationId

RetryScheduler
  schedule(jobId, delay) → void

InternalApiClient
  call(registry, idempotencyKey: JobId) → ApiOutcome
      // never throws on network/HTTP errors: translates them into ApiOutcome

DeadLetterNotifier
  notify(job) → void
```

---

## 5. Use cases

### `DispatchTick(tickTime)` — EventBridge, every minute
1. `slot = minuteOfDay(tickTime)`, `date = businessDate(tickTime)`.
2. Recover incomplete windows: `DispatchWindowRepository.findIncomplete(from = start of day, to = slot - 1)` and dispatch them as well.
3. For each window: `start` → page through `findActiveBySlot` → build `Job(PENDING, attempt 1, createdAt = now)` → `createIfAbsent` → `enqueue` → `markEnqueued` (only the jobs that were sent) → `complete`.
4. If `enqueue` reports failures, the window is not marked COMPLETED (retried on the next tick).

### `ProcessJob(jobId)` — FIFO
1. `job = tryAcquire(jobId, now, lease)`. If `null` → finish without error (ACK).
2. `registry = RegistryRepository.findById(job.registryId)`. If it is `null` or not `isActiveOn(businessDate)` → `job.failPermanent({ reason: 'registry_inactive' })` → `save` → finish **without** `DeadLetterNotifier.notify` (it is not a failure) and without calling the API.
3. `outcome = InternalApiClient.call(registry, job.id)`.
4. Depending on `outcome`:
   - `Success` → `job.succeed(...)`.
   - `TransientFailure` → `job.failTransient(...)`; if it ended in RETRY_SCHEDULED → `RetryScheduler.schedule(job.id, retryPolicy.delayFor(job.attempt, outcome.retryAfter))`; if it ended in DEAD → `DeadLetterNotifier.notify`.
   - `PermanentFailure` → `job.failPermanent(...)` → `DeadLetterNotifier.notify`.
5. `JobRepository.save(job, expectedStatus = IN_PROGRESS)`.
6. **Always ends with ACK**: retries go through `RetryScheduler`, never through FIFO redelivery (avoids blocking the provider).

### `RequeueJob(jobId)` — Retry queue
1. `job = JobRepository.findById(jobId)`; if it is `null` or not RETRY_SCHEDULED → finish.
2. `job.requeue()` → `save(job, RETRY_SCHEDULED)` → `enqueue([job])` → `markEnqueued`.

### `ReconcileStaleJobs()` — its own schedule (every N minutes, within the day)
1. `findStale(now)` → `job.reclaimStale(...)` → `save` → `enqueue` → `markEnqueued`.
2. `findPendingNotEnqueued(olderThan)` → `enqueue` → `markEnqueued`. Covers failures between `createIfAbsent` and `enqueue`, and between `enqueue` and `markEnqueued` (the resulting duplicate message is stopped by SQS deduplication or by `tryAcquire`).

---

## 6. Adapters (infrastructure)

| Port | Adapter | Details |
|---|---|---|
| `JobQueue` | `SqsFifoJobQueue` | `MessageGroupId = providerId`, `MessageDeduplicationId = jobId#attempt`, `SendMessageBatch` in chunks of 10, bounded parallel sends. |
| `RetryScheduler` | `SqsStandardRetryScheduler` | **Standard** queue with per-message `DelaySeconds` (max 900s). Clamps the delay to 900s as a defensive check; the real cap is `RetryPolicy.maxDelay`. |
| `JobRepository` | `AuroraJobRepository` | Through RDS Proxy. `tryAcquire` = `UPDATE ... SET status='IN_PROGRESS', lease_until=$ WHERE id=$ AND status='PENDING' RETURNING *`. `createIfAbsent` = `INSERT ... ON CONFLICT DO NOTHING`. |
| `RegistryRepository` | `AuroraRegistryRepository` | Index `(slot, active_from) INCLUDE (...)`. Keyset pagination. |
| `InternalApiClient` | `HttpInternalApiClient` | `Idempotency-Key: jobId` header. Explicit timeout. Classification below. |
| `DeadLetterNotifier` | `SqsDlqNotifier` + CloudWatch alarm → SNS | — |
| `Clock` | `SystemClock` / `FixedClock` (tests) | — |

### HTTP → `ApiOutcome` classification (in `HttpInternalApiClient`)

| Input | Result |
|---|---|
| 2xx | `Success` |
| 408, 429, 500, 502, 503, 504 | `TransientFailure` (429 honors `Retry-After`) |
| Other 4xx | `PermanentFailure` |
| Network error: with native `fetch` it throws `TypeError('fetch failed')` and the code is in **`error.cause.code`** (`ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`, `EAI_AGAIN`…) | `TransientFailure` |
| `AbortSignal.timeout` fired: `error.name === 'TimeoutError'` | `TransientFailure` |
| Any other unexpected client error | `TransientFailure` (when in doubt, retry: the idempotency key protects) |

### AWS configuration

- Worker ESM: `BatchSize = 1`, `ReportBatchItemFailures` enabled, configurable `MaximumConcurrency` (protects the internal API's 2 Lambdas).
- **FIFO visibility timeout = 6 × worker Lambda timeout.**
- FIFO redrive to a FIFO DLQ with `maxReceiveCount` (only for worker crashes; business retries do not use redelivery).
- Alarms: DLQ depth > 0, `ApproximateAgeOfOldestMessage`, % of the day completed per provider.

---

## 7. Testing

- **Domain**: unit tests for every valid and invalid `Job` transition, invariants, `RetryPolicy` (with a fixed RNG), `SlotCalculator` (determinism + uniformity), `StalePolicy`.
- **Use cases**: with `InMemory*` adapters and `FixedClock`. Programmable `FakeInternalApi` ("fails transiently N times, then succeeds").
- **Required scenarios**:
  - Duplicate message → `tryAcquire` returns null, the API is not called.
  - Transient until exhausted → DEAD + notify.
  - Permanent → DEAD without retry.
  - Worker dies in IN_PROGRESS → `ReconcileStaleJobs` reclaims it after the lease.
  - Missed tick → the next `DispatchTick` dispatches the missing window.
  - Partial `enqueue` failure → window not COMPLETED; reconciliation re-enqueues the PENDING jobs.
  - Crash between `enqueue` and `markEnqueued` → reconciliation re-enqueues; the job runs once.
  - Registry deleted or deactivated after dispatch → job DEAD with `registry_inactive`, no API call, no notify.
  - `Retry-After` larger than `maxDelay` → delay capped at `maxDelay`.
- **Adapters**: shared contract tests run against both `InMemory*` and the real adapter (Postgres in a container, LocalStack for SQS). `tryAcquire` atomicity is tested with two concurrent calls.
- **HTTP classification**: use real client errors (with `code`), not hand-built objects.

---

## 8. Known pitfalls to avoid

- Reading `error.name` instead of the error code for network errors (with native `fetch`, the code lives in `error.cause.code`).
- Checking state and then writing unconditionally (read-then-write): always use conditional writes.
- Retrying via FIFO redelivery: it blocks the whole provider during the backoff.
- Reusing the same `DeduplicationId` on re-enqueue: SQS silently drops it within the 5-minute window.
- Two sources of truth for attempts: the counter lives in the `Job`, not in `ApproximateReceiveCount`.
- Loading the whole day into memory to reconcile: paginate or resolve it in SQL.
- Window lookback limited to a few minutes: recover every incomplete window of the day.