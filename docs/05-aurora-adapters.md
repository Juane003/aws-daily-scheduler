# Stage 5 — Aurora adapters

**Requirements:** R1, R3, C1 · **Depends on:** 3 · **CLAUDE.md:** §6 (`AuroraJobRepository`, `AuroraRegistryRepository`), §8

## Goal

Postgres implementations of `JobRepository`, `RegistryRepository` and `DispatchWindowRepository`, accessed through RDS Proxy with `pg`, passing the stage 3 contract tests against a real Postgres in Testcontainers.

## Files

```
db/migrations/
  001_registry.sql         registry table + index (slot, active_from) INCLUDE (...)
  002_jobs.sql             jobs table, status check constraint, indexes for stale / pending-not-enqueued
  003_dispatch_windows.sql (business_date, slot) PK, status, count, timestamps
src/infrastructure/adapters/aurora/
  PgPool.ts                    pool created once, outside the handler
  AuroraRegistryRepository.ts
  AuroraJobRepository.ts
  AuroraDispatchWindowRepository.ts
  mappers.ts                   row ↔ domain (Job.restore, Registry)
tests/infrastructure/aurora/
  *.test.ts                    run the contract suites against Testcontainers Postgres
```

## Design notes

- **Parameterized queries only.** No string interpolation into SQL.
- `tryAcquire`: `UPDATE jobs SET status='IN_PROGRESS', lease_until=$2 WHERE id=$1 AND status='PENDING' RETURNING *`.
- `createIfAbsent`: multi-row `INSERT ... ON CONFLICT (id) DO NOTHING`, chunked (e.g. 1 000 rows per statement).
- `save(job, expectedStatus)`: `UPDATE ... WHERE id=$1 AND status=$expected`; `rowCount = 0` → `ConcurrencyConflict`.
- `findActiveBySlot`: keyset pagination on `(slot, id)`; the `isActiveOn` filter is expressed in SQL (`active_from <= $date AND (inactive_from IS NULL OR $date < inactive_from) AND enabled`). Index: `(slot, active_from) INCLUDE (...)` per §6.
- `jobs` has `created_at NOT NULL` and `enqueued_at NULL`.
- `markEnqueued(ids, at)`: one statement per batch — `UPDATE jobs SET enqueued_at=$2 WHERE id = ANY($1) AND status='PENDING'`.
- `findStale` / `findPendingNotEnqueued`: resolved in SQL with `LIMIT`, backed by partial indexes (`(lease_until) WHERE status='IN_PROGRESS'`, `(created_at) WHERE status='PENDING' AND enqueued_at IS NULL`).
- `save` writes `enqueued_at` too, so the reset done by `requeue` / `reclaimStale` is persisted.
- Results (R3) stored in the jobs table (`result jsonb`, `last_error text`), or a separate `job_results` table — record the choice.
- `pg` errors are caught and rethrown as adapter/application errors; never leaked upward.
- Connection settings from env (`DB_HOST` = RDS Proxy endpoint, IAM auth token or Secrets Manager — decide in stage 9).
- Migration runner: a small script or `node-pg-migrate`; record the choice.
- Job table growth (~1M rows/day × N): plan monthly partitioning by business date and a retention policy. Can be documented now and implemented later.

## Tests

- Contract suites from stage 3 against Testcontainers Postgres (`@testcontainers/postgresql`).
- `tryAcquire` concurrency: two parallel calls on separate connections → exactly one wins.
- `EXPLAIN` check (optional) that `findActiveBySlot` uses the index.

## Definition of done

- [ ] Migrations apply cleanly on an empty database.
- [ ] Contract suites green against Postgres.
- [ ] No raw `pg` errors escape the adapters.

## Decisions

_(record here: result storage, migration tool, partitioning plan)_
