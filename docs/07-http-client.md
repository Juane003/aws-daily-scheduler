# Stage 7 — HTTP internal API client

**Requirements:** R4, C3 · **Depends on:** 3 · **CLAUDE.md:** §6 (`HttpInternalApiClient`, HTTP classification), §8

## Goal

`HttpInternalApiClient` implementing `InternalApiClient.call(registry, idempotencyKey)` with native `fetch`, which **never throws** for network/HTTP failures and maps every input to an `ApiOutcome`.

## Files

```
src/infrastructure/adapters/http/
  HttpInternalApiClient.ts
  classify.ts               pure: (Response | error) → ApiOutcome
  retryAfter.ts             parse Retry-After (delta-seconds or HTTP-date, relative to Clock)
tests/infrastructure/http/
  classify.test.ts
  HttpInternalApiClient.test.ts   against a local node:http server
```

## Design notes

- Request: method/body from the registry (`endpoint`, `body`), header `Idempotency-Key: <jobId>`, `AbortSignal.timeout(ms)` with an explicit, configurable timeout (C3: the API runs two Lambdas, budget for both).
- Classification exactly as the §6 table:
  - 2xx → `Success(payload)` (parse JSON; fall back to text).
  - 408, 429, 500, 502, 503, 504 → `TransientFailure`; 429 honours `Retry-After`.
  - other 4xx → `PermanentFailure`.
  - `TypeError('fetch failed')` → read **`error.cause.code`** (`ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`, `EAI_AGAIN`, …) → `TransientFailure` with the code as reason.
  - `error.name === 'TimeoutError'` → `TransientFailure`.
  - anything else → `TransientFailure` (idempotency key protects).
- Decide: other 5xx not in the list (501, 505…) — §6 lists them under neither; the "when in doubt, retry" rule suggests transient. Record the choice.
- Bound the response body size read for `Success` payloads stored in Aurora.

## Tests

Use **real errors**, not hand-built objects (§7):
- Local `node:http` server returning each status code; `Retry-After` in seconds and as a date.
- Connection refused: point at a closed port → real `ECONNREFUSED` in `cause.code`.
- Connection reset: server destroys the socket → real `ECONNRESET`/`UND_ERR_SOCKET`.
- Timeout: server never responds, short `AbortSignal.timeout` → `TimeoutError`.
- DNS failure: unresolvable host → `ENOTFOUND`/`EAI_AGAIN`.
- `Idempotency-Key` header received by the server equals the job id.

## Definition of done

- [ ] Every row of the §6 classification table covered by a test with a real error.
- [ ] `call` has no code path that throws on network/HTTP errors.

## Decisions

_(record here: other 5xx; timeout default; max payload size)_
