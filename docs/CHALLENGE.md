# CHALLENGE.md — Requirements Reference (read-only)

> **Precedence rule for Claude**
> This file is a **requirements reference only**. It describes *what* the problem asks for.
> **`CLAUDE.md` is the single source of truth for *how* to implement it** (architecture, domain model, ports, adapters, conventions, testing).
> - Always follow `CLAUDE.md`.
> - Use this file only to check what a requirement says or why something exists.
> - If anything here seems to conflict with `CLAUDE.md`, follow `CLAUDE.md` and flag the conflict to the user instead of changing the design on your own.
> - Do not derive new design decisions, services or patterns from this file.

---

## Original statement (Spanish, verbatim)

### Desafío técnico tapi

Este desafío técnico está diseñado para evaluar las habilidades técnicas de un candidato a desarrollador de software. A través de este ejercicio práctico, queremos asegurarnos de que el candidato posee la capacidad para desarrollar aplicaciones robustas y seguras, implementando mejores prácticas en el desarrollo de software.

#### Problema

Partiendo de una base de datos que cuenta con una tabla con N registros (Ej registro: id, proveedor, endpoint, body), y que cada registro representa una consulta que se debe realizar a una API interna, se requiere:

- Realizar una consulta diaria para cada registro de forma automática. Las consultas deben estar distribuidas a lo largo del día.
- Guardar el resultado de la consulta en una base de datos.
- Contemplar el manejo de errores teniendo en cuenta que algunos se pueden reintentar y otros no.
- Evitar concurrencia a un mismo proveedor.

#### Tecnología disponible

- Todo el stack de AWS.

#### Consideraciones

- La tabla de registros tiene 1 millón de filas pudiendo escalar N veces.
- Todos los servicios se encuentran en la misma región y cuenta de AWS.
- La API interna a la que se realizan los llamados ejecuta dos lambdas.

#### Criterios de evaluación

- Diagrama de arquitectura claro y bien documentado.
- Justificación de las decisiones arquitectónicas tomadas.
- Ciclo de Vida de Desarrollo.
- Plan de desarrollo.

---

## Requirements index (English)

Use these IDs when referring to a requirement in code comments, tests, commits or PRs.

| ID | Requirement | Where `CLAUDE.md` covers it |
|---|---|---|
| R1 | Run one call per registry row per day, automatically | §2 `JobId` (registryId#date), §5 `DispatchTick` |
| R2 | Calls are spread across the day | §3 `SlotCalculator`, §5 `DispatchTick` (window recovery) |
| R3 | Store each call's result in a database | §2 `Job.succeed(result)`, §6 `AuroraJobRepository` |
| R4 | Handle errors: some retryable, some not | §2 `ApiOutcome`, §3 `RetryPolicy`, §5 `ProcessJob` / `RequeueJob`, §6 HTTP classification |
| R5 | No concurrency against the same provider | §2 `ProviderId`, §6 `SqsFifoJobQueue` (`MessageGroupId`), §6 AWS configuration |
| C1 | 1M rows, must scale N times | §6 keyset pagination, batched sends, `MaximumConcurrency` |
| C2 | Single AWS region and account | — (assumption, no design impact) |
| C3 | The internal API runs two Lambdas per call | §6 `MaximumConcurrency`, explicit HTTP timeout |
| Q1 | Robust and secure applications, best practices | §1 architecture rules, §7 testing, §8 pitfalls |

Evaluation criteria (diagram, decision rationale, SDLC, development plan) are deliverables outside the code; they are not implementation instructions.