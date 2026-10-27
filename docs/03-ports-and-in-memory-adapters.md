# Stage 3 — Ports and in-memory adapters

**Requirements:** — (enabler) · **Depends on:** 1, 2 · **CLAUDE.md:** §4, §6 (`Clock`), §7

## Goal

Define every outbound port as a TypeScript `interface`, plus an in-memory implementation of each, and a **shared contract test suite** that later runs unchanged against the real adapters (stages 5–7).

## Files

```
src/application/ports/out/
  Clock.ts  RegistryRepository.ts  JobRepository.ts  DispatchWindowRepository.ts
  JobQueue.ts  RetryScheduler.ts  InternalApiClient.ts  DeadLetterNotifier.ts
  Page.ts                     Page<T> = { items: T[]; nextCursor?: Cursor }
  ConcurrencyConflict.ts      thrown by save() when expectedStatus does not match
src/infrastructure/adapters/inmemory/
  InMemoryRegistryRepository.ts  InMemoryJobRepository.ts  InMemoryDispatchWindowRepository.ts
  InMemoryJobQueue.ts  InMemoryRetryScheduler.ts  InMemoryDeadLetterNotifier.ts
  FixedClock.ts               (settable / advanceable)
  FakeInternalApi.ts          programmable: "transient N times, then success", "permanent", per registry
src/infrastructure/adapters/
  SystemClock.ts
tests/contracts/
  jobRepository.contract.ts  registryRepository.contract.ts
  dispatchWindowRepository.contract.ts  jobQueue.contract.ts
```

## Design notes

- Contracts exactly as in §4, including `RegistryRepository.findById`, `JobRepository.findById` and `JobRepository.markEnqueued(jobIds, at)`.
- `markEnqueued` is bulk and only affects jobs still PENDING (one statement per batch in SQL, not one `save` per job).
- `findPendingNotEnqueued(olderThan, limit)` = `status = PENDING AND enqueuedAt IS NULL AND createdAt < olderThan`.
- `JobQueue.enqueue` returns `{ failed: JobId[] }`; the in-memory version can be told to fail specific ids (for the partial-failure scenario).
- `InMemoryJobRepository.tryAcquire` must be atomic within the process (single synchronous check-and-set, no `await` between check and write) so it obeys the same contract as SQL.
- `save(job, expectedStatus)` throws `ConcurrencyConflict` (an application-level error, not an SDK error) when the stored status differs.
- In-memory adapters live in `infrastructure/` but are used only by tests (§1 tree).

## Contract tests

Each `*.contract.ts` exports `describeJobRepositoryContract(name, factory)` and is invoked from `tests/infrastructure/inmemory/*.test.ts` now and from the real-adapter tests later. Minimum cases:

- `createIfAbsent` is idempotent and never overwrites an existing `JobId`.
- `tryAcquire`: PENDING → IN_PROGRESS with lease; returns `null` for any other status; **two concurrent calls → exactly one non-null**.
- `save` with wrong `expectedStatus` → `ConcurrencyConflict`.
- `findStale` returns only IN_PROGRESS with expired lease, respects `limit`.
- `findPendingNotEnqueued` returns only PENDING jobs with no `enqueuedAt` and `createdAt < olderThan`; respects `limit`.
- `markEnqueued` sets `enqueuedAt` on PENDING jobs and leaves jobs in any other status untouched.
- `findById` returns `null` for unknown ids (both repositories).
- `findActiveBySlot`: filters by slot and `isActiveOn(date)`; keyset pagination returns every row exactly once across pages.
- `DispatchWindowRepository.start` returns `false` once completed; `findIncomplete` returns started-but-not-completed **and** never-started windows in range.

## Definition of done

- [ ] All ports defined; `application/` compiles with no infrastructure import.
- [ ] In-memory adapters pass the contract suites.

## Decisions

_(record here: whether `findIncomplete` returns never-started slots)_
