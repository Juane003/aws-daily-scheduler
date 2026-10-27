# Stage 10 — Evaluation deliverables

**Requirements:** evaluation criteria in `CHALLENGE.md` · **Depends on:** all (can start in parallel once the design is stable)

## Goal

The non-code deliverables the challenge is evaluated on. They describe the design in `CLAUDE.md`; they do not introduce new design.

## Deliverables

| Criterion | Document | Content |
|---|---|---|
| Clear, well-documented architecture diagram | `docs/architecture.md` | Component diagram (EventBridge → dispatcher → Aurora / SQS FIFO → worker → internal API; retry queue → requeue; reconciler; DLQs → alarms → SNS). Sequence diagrams for: happy path, transient retry, permanent failure, stale reclaim, missed tick. Mermaid so it renders on GitHub. |
| Justification of architectural decisions | `docs/decisions/` (ADRs) | One short ADR each: FIFO group per provider (R5); retries via delayed standard queue, not FIFO redelivery; `JobId = registryId#date` for idempotency (R1); hashed slots across 1440 minutes (R2); Aurora + RDS Proxy; atomic `tryAcquire`; lease-based reconciliation; hexagonal architecture. Each with context, decision, alternatives, consequences. |
| Development life cycle | `docs/sdlc.md` | Branching and PR flow, CI checks, test pyramid (domain → use cases → contract → e2e), environments, deployment and rollback, observability and on-call. |
| Development plan | `docs/README.md` (this plan) | Stages, dependencies, and status; updated as stages close. |

## Capacity notes to include in the architecture doc (C1)

- 1M rows / 1440 slots ≈ 700 jobs per minute; N× scale → 700·N per minute.
- Throughput per provider is bounded by one in-flight call; providers with many rows need calls shorter than `86 400 s / rows_for_provider`. Document the formula and how the "% of day completed per provider" alarm detects violations.
- Worker `MaximumConcurrency` vs. internal API capacity (C3).

## Definition of done

- [ ] All documents above exist and match the implemented code.
- [ ] Every requirement ID (R1–R5, C1–C3, Q1) is traceable to an ADR and to tests.
