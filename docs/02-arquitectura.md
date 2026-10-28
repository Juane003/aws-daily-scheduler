# 02 — Arquitectura

> Diseño objetivo en AWS. La implementación de referencia ejecuta la misma lógica sobre adaptadores en memoria; nada de esto fue desplegado.

## Diagrama

El diagrama completo, con anotaciones, está en [`diagrams/arquitectura.excalidraw`](diagrams/arquitectura.excalidraw) (abrir con [excalidraw.com](https://excalidraw.com)). Esta versión en Mermaid muestra los mismos componentes y flujos:

```mermaid
flowchart LR
  subgraph Programación
    EB1[EventBridge Scheduler<br/>cada 1 min]
    EB2[EventBridge Scheduler<br/>cada 1 h]
  end
  subgraph VPC privada
    D[Dispatcher Lambda]
    W[Worker Lambda]
    RQ[Requeue Lambda]
    RC[Reconciler Lambda]
    P[RDS Proxy]
    DB[(Aurora PostgreSQL<br/>registries · executions · results<br/>dispatch_windows · provider_circuits)]
  end
  F[[SQS FIFO<br/>GroupId = provider]]
  R[[SQS standard retry<br/>DelaySeconds]]
  DLQ[[DLQ FIFO]]
  RDLQ[[DLQ de retry]]
  S3[(S3<br/>payloads > 256 KB)]
  API[API interna<br/>API Gateway → 2 Lambdas]

  EB1 --> D
  D -->|slot + lookback,<br/>INSERT ENQUEUED| P
  D -->|SendMessageBatch| F
  F -->|ESM BatchSize = 1<br/>MaximumConcurrency| W
  W -->|claim, breaker, resultado| P
  W -->|Idempotency-Key| API
  W -->|reintentable / breaker OPEN| R
  W -->|no reintentable / agotado / vencido| DLQ
  W --> S3
  F -.->|maxReceiveCount = 3| DLQ
  R -->|batch 10| RQ --> F
  R -.->|maxReceiveCount| RDLQ
  EB2 --> RC
  RC -->|stale, faltantes, stats| P
  RC --> F
  P --> DB
```

## Componentes

| Componente                    | Responsabilidad                                                                                                                                                                       | Decisión    | Código                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------- |
| EventBridge Scheduler (1 min) | Dispara el Dispatcher una vez por minuto. Un solo schedule para toda la plataforma.                                                                                                   | D2          | —                                            |
| Dispatcher Lambda             | Despacha el slot del minuto y los 5 anteriores no completados: registra cada job como `ENQUEUED` y lo encola en la FIFO.                                                              | D1, D3, D4  | `src/core/dispatch/dispatcher.ts`            |
| SQS FIFO                      | Cola principal. `MessageGroupId = providerId` garantiza una llamada en curso por proveedor; `MessageDeduplicationId = jobId#seq` descarta duplicados por 5 min.                       | D5          | `src/adapters/memory/fifo-queue.ts`          |
| Event source mapping          | Invoca al Worker con `BatchSize = 1`; `MaximumConcurrency` acota la carga total sobre la API interna y Aurora.                                                                        | D6          | `src/simulation/harness.ts` (simulado)       |
| Worker Lambda                 | Deadline, circuit breaker, claim condicional, llamada a la API interna, clasificación del resultado y una de sus ramas (éxito, reintento, DLQ).                                       | D7, D8, D12 | `src/core/execute/worker.ts`                 |
| SQS standard `retry`          | Reintentos con `DelaySeconds` por mensaje (backoff o defer del breaker), fuera de la FIFO para no bloquear el grupo del proveedor.                                                    | D7          | `src/adapters/memory/standard-queue.ts`      |
| Requeue Lambda                | Devuelve a la FIFO los mensajes de `retry` cuando vence su delay. No toca la base.                                                                                                    | D7          | `src/core/execute/requeue.ts`                |
| DLQ FIFO                      | Cuarentena: no reintentables, intentos agotados, vencidos, inválidos y poison messages (redrive). Con alarma y camino de redrive.                                                     | D9          | `scripts/redrive-dlq.ts`                     |
| DLQ de `retry` (standard)     | Mensajes que la Requeue no pudo devolver a la FIFO tras `maxReceiveCount` intentos.                                                                                                   | D9          | —                                            |
| EventBridge Scheduler (1 h)   | Dispara el Reconciler.                                                                                                                                                                | D10         | —                                            |
| Reconciler Lambda             | Red de seguridad del día: re-encola `IN_PROGRESS` stale y registros sin ejecución; reporta `ENQUEUED` viejos y publica el % completado.                                               | D10         | `src/core/reconcile/reconciler.ts`           |
| Aurora PostgreSQL + RDS Proxy | Fuente de verdad: registros, ejecuciones (particionadas por mes), resultados, ventanas del Dispatcher y estado del breaker. El proxy multiplexa las conexiones de cientos de Lambdas. | D11         | `database/migrations/`                       |
| S3                            | Payloads de resultado mayores a 256 KB.                                                                                                                                               | D11         | `src/core/execute/worker.ts`                 |
| API interna                   | Fuera del sistema. Recibe `Idempotency-Key: jobId` y `X-Provider-Id`.                                                                                                                 | D12         | `src/simulation/api-simulator.ts` (simulada) |

## Secuencia end-to-end

### Camino feliz

```mermaid
sequenceDiagram
  autonumber
  participant EB as EventBridge (1 min)
  participant D as Dispatcher
  participant DB as Aurora
  participant F as SQS FIFO
  participant W as Worker
  participant API as API interna
  EB->>D: tick (minuto m)
  D->>DB: dispatch_windows(hoy, m) → PROCESSING
  D->>DB: SELECT registries WHERE slot = m (páginas de 1.000)
  D->>DB: INSERT executions ENQUEUED ON CONFLICT DO NOTHING RETURNING
  D->>F: SendMessageBatch (GroupId = provider, DedupId = jobId#0)
  D->>DB: dispatch_windows → COMPLETED
  F->>W: mensaje (uno por grupo en vuelo)
  W->>DB: provider_circuits (¿CLOSED?)
  W->>DB: claim: UPDATE → IN_PROGRESS, attempt + 1
  W->>DB: SELECT registry
  W->>API: POST endpoint (Idempotency-Key = jobId)
  API-->>W: 200
  W->>DB: results + SUCCEEDED (una transacción)
  W-->>F: ACK (el ESM borra el mensaje)
```

### Reintento y circuit breaker

```mermaid
sequenceDiagram
  autonumber
  participant F as SQS FIFO
  participant W as Worker
  participant DB as Aurora
  participant API as API interna
  participant R as SQS retry
  participant RQ as Requeue
  F->>W: job A (proveedor p)
  W->>API: llamada
  API-->>W: 503
  W->>DB: breaker: falla consecutiva n
  W->>DB: RETRYING, seq + 1, next_attempt_at
  W->>R: SendMessage (DelaySeconds = backoff)
  W-->>F: ACK → el grupo p se libera
  Note over DB: a la 5.ª falla seguida: OPEN por 60 s
  F->>W: job B (proveedor p)
  W->>DB: breaker OPEN
  W->>DB: RETRYING (sin sumar intento)
  W->>R: SendMessage (delay = open_until − now + jitter)
  W-->>F: ACK
  R->>RQ: al vencer el delay
  RQ->>F: SendMessage (DedupId = jobId#seq)
  F->>W: job A (tras el cooldown)
  W->>DB: OPEN vencido → HALF_OPEN (gana la prueba)
  W->>API: llamada de prueba
  API-->>W: 200
  W->>DB: CLOSED · results + SUCCEEDED
```

Los escenarios de falla (crashes, envíos fallidos, duplicados) están en `06-idempotencia-y-consistencia.md`.

## Ciclo de vida de una ejecución

```mermaid
stateDiagram-v2
  [*] --> ENQUEUED: Dispatcher / Reconciler
  ENQUEUED --> IN_PROGRESS: claim
  ENQUEUED --> RETRYING: breaker OPEN (defer)
  RETRYING --> IN_PROGRESS: claim
  RETRYING --> RETRYING: defer
  IN_PROGRESS --> SUCCEEDED: 2xx
  IN_PROGRESS --> RETRYING: reintentable / stale (Reconciler)
  IN_PROGRESS --> IN_PROGRESS: claim por stale
  IN_PROGRESS --> FAILED_NON_RETRYABLE: 4xx
  IN_PROGRESS --> FAILED_EXHAUSTED: attempt = maxAttempts
  ENQUEUED --> FAILED_EXPIRED: pasado el deadline
  RETRYING --> FAILED_EXPIRED: pasado el deadline
  IN_PROGRESS --> FAILED_EXPIRED: pasado el deadline
  SUCCEEDED --> [*]
  FAILED_NON_RETRYABLE --> [*]
  FAILED_EXHAUSTED --> [*]
  FAILED_EXPIRED --> [*]
```

## Arquitectura del código

Hexagonal liviana: los handlers (`src/handlers/`) solo cablean; la lógica vive en `src/core/` y depende de puertos (`src/core/ports.ts`, `src/common/telemetry.ts`); los adaptadores en memoria (`src/adapters/memory/`) implementan esos puertos para los tests y la simulación. Un adaptador AWS reemplazaría a cada uno sin tocar el núcleo:

| Puerto                                                   | Adaptador en memoria                         | Adaptador AWS (diseño objetivo)                     |
| -------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------- |
| `FifoQueue`, `StandardQueue`                             | `InMemoryFifoQueue`, `InMemoryStandardQueue` | SQS (`SendMessage`, `SendMessageBatch`)             |
| `Repository` (registries, executions, windows, circuits) | `InMemoryRepository`                         | `pg` sobre RDS Proxy, con IAM auth                  |
| `InternalApi`                                            | `ApiSimulator`                               | `fetch` con `AbortSignal.timeout` y SigV4 si aplica |
| `ObjectStore`                                            | `InMemoryObjectStore`                        | S3 `PutObject`                                      |
| `Clock`                                                  | `VirtualClock`                               | `new Date()`                                        |
| `Logger`, `Metrics`                                      | `InMemoryLogger`, `InMemoryMetrics`          | Powertools Logger y Metrics (EMF)                   |
