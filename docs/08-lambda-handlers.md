# Stage 8 — Lambda handlers (composition roots)

**Requirements:** R1, R2 (wiring of all) · **Depends on:** 4, 5, 6, 7 · **CLAUDE.md:** §1 (thin handlers), Stack (manual composition root)

## Goal

Four thin handlers, each with a manual composition root: parse event → call one use case → translate result.

## Files

```
src/infrastructure/handlers/
  dispatcher.ts    EventBridge schedule (every minute) → DispatchTick(event.time)
  worker.ts        SQS FIFO event (BatchSize 1) → ProcessJob(jobId)
  requeue.ts       SQS standard retry event → RequeueJob(jobId)
  reconciler.ts    EventBridge schedule (every N minutes) → ReconcileStaleJobs()
  config.ts        env parsing/validation (queue URLs, DB, timeouts, retry config)
  logger.ts        structured JSON logs (jobId, providerId, attempt, outcome)
```

## Design notes

- Clients (`SQSClient`, `pg` pool) and use cases are built **once at module scope**, outside the handler function.
- `config.ts` fails fast at cold start on missing/invalid env vars.
- The composition root sets `RetryPolicy.maxDelay = 900 s` (SQS `DelaySeconds` limit) — the only place that knows about it.
- `worker` and `requeue` return `SQSBatchResponse` (`batchItemFailures`). Business outcomes always ACK; only an unexpected crash (e.g. DB unreachable) reports the item as failed, so FIFO redrive → DLQ covers worker crashes only (§6).
- `dispatcher` uses the EventBridge `time` field as `tickTime`, not the Lambda's clock, so a delayed invocation still targets the right slot.
- No business `if`s in handlers. Message parsing errors (malformed body) → log + ACK (a poison message must not block the provider group).
- Bundling: `esbuild` per handler (tree-shaken, ESM output, `nodejs22.x`).

## Tests

- Per handler: a test with a sample AWS event and in-memory adapters injected through an exported `buildHandler(deps)` factory; the default export wires real adapters.
- Smoke test: whole flow against LocalStack + Testcontainers Postgres + local HTTP fake (dispatch → worker → retry → requeue → success).

## Definition of done

- [ ] Four handlers bundle and run locally.
- [ ] End-to-end smoke test green.

## Decisions

_(record here)_
