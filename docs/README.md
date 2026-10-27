# Implementation plan

This folder breaks the implementation into stages. Each stage is a separate document with its scope, the requirements it covers, the files it produces, its tests and a definition of done.

- **`CLAUDE.md` is the source of truth for the design.** These documents order the work and point to the relevant `CLAUDE.md` section; they do not redefine it.
- **[`CHALLENGE.md`](CHALLENGE.md)** holds the requirement IDs (R1–R5, C1–C3, Q1) used below.

## Stages

| # | Stage | Layer | Requirements | Depends on |
|---|---|---|---|---|
| 0 | [Project baseline](00-project-baseline.md) | tooling | Q1 | — |
| 1 | [Domain model](01-domain-model.md) | `domain/model`, `domain/errors` | R1, R3, R4 | 0 |
| 2 | [Domain policies](02-domain-policies.md) | `domain/policies` | R2, R4 | 1 |
| 3 | [Ports and in-memory adapters](03-ports-and-in-memory-adapters.md) | `application/ports/out`, `infrastructure/adapters/InMemory*` | — | 1, 2 |
| 4 | [Use cases](04-use-cases.md) | `application/usecases` | R1–R5 | 3 |
| 5 | [Aurora adapters](05-aurora-adapters.md) | `infrastructure/adapters/Aurora*` | R1, R3, C1 | 3 |
| 6 | [SQS adapters](06-sqs-adapters.md) | `infrastructure/adapters/Sqs*` | R4, R5, C1 | 3 |
| 7 | [HTTP internal API client](07-http-client.md) | `infrastructure/adapters/Http*` | R4, C3 | 3 |
| 8 | [Lambda handlers](08-lambda-handlers.md) | `infrastructure/handlers` | R1, R2 | 4–7 |
| 9 | [AWS infrastructure and observability](09-aws-infrastructure.md) | IaC | R5, C1, C3 | 8 |
| 10 | [Evaluation deliverables](10-evaluation-deliverables.md) | docs | evaluation criteria | all |

Stages 5, 6 and 7 are independent of each other and can be done in any order once stage 3 is finished.

## Per-stage workflow

1. Write the domain/contract tests first; then the code.
2. `npm run typecheck && npm run lint && npm test` must pass before the stage is closed.
3. One branch / PR per stage; commit messages reference requirement IDs (e.g. `feat(domain): Job state machine (R1, R4)`).
4. Tick the stage's definition of done and record any decisions in its "Decisions" section.

## Resolved questions

Gaps found while planning; all resolved in `CLAUDE.md`.

| # | Question | Resolution (`CLAUDE.md`) |
|---|---|---|
| Q-1 | How `ProcessJob` loads the registry. | `RegistryRepository.findById` (§4). Missing/inactive registry → DEAD `registry_inactive`, no API call, no notify (§5). |
| Q-2 | How `RequeueJob` loads the job. | `JobRepository.findById` (§4). |
| Q-3 | How `findPendingNotEnqueued` knows a job was enqueued. | `Job.createdAt`, `Job.enqueuedAt`, `Job.markEnqueued`; bulk `JobRepository.markEnqueued`; `enqueuedAt` cleared on `requeue` / `reclaimStale` (§2, §4, §5). |
| Q-4 | SQS `DelaySeconds` max 900 s. | `RetryPolicy.maxDelay` config, set to 900 s by the composition root; adapter clamps defensively (§3, §6). |
| Q-5 | IaC tool. | AWS CDK in TypeScript (Stack). |
| Q-6 | Test runner. | Vitest (Stack). |
