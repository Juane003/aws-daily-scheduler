# Stage 6 — SQS adapters

**Requirements:** R4, R5, C1 · **Depends on:** 3 · **CLAUDE.md:** §6 (`SqsFifoJobQueue`, `SqsStandardRetryScheduler`, `SqsDlqNotifier`), §8

## Goal

SQS implementations of `JobQueue`, `RetryScheduler` and `DeadLetterNotifier`, tested against LocalStack.

## Files

```
src/infrastructure/adapters/sqs/
  sqsClient.ts                   SQSClient created once, outside the handler
  SqsFifoJobQueue.ts
  SqsStandardRetryScheduler.ts
  SqsDlqNotifier.ts
  messages.ts                    message body schema + parse/serialize (jobId only)
tests/infrastructure/sqs/
  *.test.ts                      LocalStack via Testcontainers
```

## Design notes

### `SqsFifoJobQueue` (R5)
- `MessageGroupId = providerId` → at most one in-flight message per provider.
- `MessageDeduplicationId = jobId#attempt` → a re-enqueue after retry/reclaim (new attempt) is **not** silently dropped by the 5-minute dedup window (§8).
- `SendMessageBatch` in chunks of 10, with bounded parallelism (e.g. 10–20 concurrent batches).
- Collect per-entry `Failed` results and any whole-batch exception into `{ failed: JobId[] }`; never throw for partial failure.
- Body: `{ jobId }` only — the worker reloads state from the database (single source of truth for attempts, §8).
- Batch entry `Id` must be unique within the batch and match `[A-Za-z0-9_-]{1,80}`; map it back to `JobId` (do not use the raw job id, it contains `#`).

### `SqsStandardRetryScheduler`
- Standard queue, `DelaySeconds = ceil(delay)`, clamped to `[0, 900]` as a defensive check only; the real cap is `RetryPolicy.maxDelay`.

### `SqsDlqNotifier`
- Sends the dead job's id, provider, attempt and last error to a DLQ-style queue; a CloudWatch alarm on its depth notifies SNS (stage 9).

### Errors
- SDK exceptions are translated into adapter errors; the use case never sees `@aws-sdk` types.

## Tests

- Contract suite for `JobQueue` against LocalStack (FIFO queue created per test run).
- Batching: 25 jobs → 3 `SendMessageBatch` calls.
- Group and dedup ids set as specified (receive and inspect attributes).
- Re-enqueue of the same job with `attempt.next()` is delivered; same attempt within 5 min is deduplicated.
- Partial failure surfaces the right `JobId`s (use a unit test with a stubbed client for this case).
- Retry delay clamped at 900 s.

## Definition of done

- [ ] All three adapters implemented and green against LocalStack.
- [ ] No SQS concepts (`MessageGroupId`, `receiptHandle`, …) outside `infrastructure/`.

## Decisions

_(record here)_
