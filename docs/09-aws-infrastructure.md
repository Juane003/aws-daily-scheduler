# Stage 9 — AWS infrastructure and observability

**Requirements:** R5, C1, C3 · **Depends on:** 8 · **CLAUDE.md:** §6 (AWS configuration)

## Goal

Infrastructure as code (AWS CDK in TypeScript, per `CLAUDE.md` Stack) for every AWS resource, with the configuration §6 prescribes, plus alarms and dashboards.

## Resources

| Resource | Configuration |
|---|---|
| EventBridge rule — dispatcher | `rate(1 minute)` |
| EventBridge rule — reconciler | every N minutes (configurable) |
| SQS FIFO jobs queue | visibility timeout = **6 × worker timeout**; redrive to FIFO DLQ with `maxReceiveCount` |
| SQS FIFO DLQ | crashes only |
| SQS standard retry queue | per-message `DelaySeconds`; its own DLQ |
| SQS dead-letter notification queue | consumed by alarm only |
| Lambda dispatcher / worker / requeue / reconciler | `nodejs22.x`, arm64, in VPC private subnets |
| Worker event source mapping | `BatchSize = 1`, `ReportBatchItemFailures`, configurable `MaximumConcurrency` (protects the internal API's two Lambdas, C3) |
| Aurora PostgreSQL + RDS Proxy | private subnets; credentials in Secrets Manager or IAM auth |
| VPC endpoints | SQS, Secrets Manager, CloudWatch Logs (no NAT required for AWS calls) |
| SNS topic | alarm notifications |

## Alarms and dashboards

- DLQ depth > 0 (FIFO DLQ, retry DLQ, dead-letter notification queue).
- `ApproximateAgeOfOldestMessage` on the FIFO queue.
- % of the day completed per provider (custom metric emitted by the reconciler or a query; EMF logs).
- Lambda errors/throttles per function; RDS Proxy connection saturation.

## Security

- Least-privilege IAM role per Lambda (dispatcher cannot receive from the queue, etc.).
- Encryption at rest (SQS SSE, Aurora KMS); TLS to RDS Proxy.
- No secrets in environment variables in plain text.

## Environments

- `dev`, `staging`, `prod` stacks from the same code with per-env parameters (`MaximumConcurrency`, lease, retry limits).

## Definition of done

- [ ] `cdk synth` produces the stack; snapshot / assertion tests on key properties (visibility timeout, ESM settings, FIFO flags).
- [ ] Deployed to `dev`, smoke test passes against real AWS.
- [ ] Alarms fire in a forced-failure test.

## Decisions

- IaC: AWS CDK in TypeScript.

_(record here: DB auth method, reconciler interval)_
