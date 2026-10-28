# ADR-007: Reintentos fuera de la FIFO: cola retry + Requeue

- **Estado:** aceptada
- **Fecha:** 2026-10-28
- **Decisión de CLAUDE.md:** D7

## Contexto

Un error reintentable necesita un delay (backoff exponencial, o `Retry-After`). Si el mensaje se queda en la FIFO durante ese delay, el grupo del proveedor queda bloqueado.

## Decisión

El Worker hace ACK y envía el job a una cola SQS **standard** `retry` con `DelaySeconds` por mensaje (backoff con full jitter, máximo 900 s). Una Requeue Lambda consume `retry` y devuelve cada mensaje a la FIFO con `MessageDeduplicationId = jobId#seq`.

## Alternativas consideradas

- **Reintentar en la FIFO** (sin ACK o con `ChangeMessageVisibility`): bloquea al proveedor durante todo el backoff.
- **`DelaySeconds` en la FIFO:** las colas FIFO solo admiten delay por cola, no por mensaje (a verificar en la documentación de SQS).
- **Step Functions con un `Wait`:** costo por transición y otro componente para algo que SQS resuelve.

## Consecuencias

- **Positivas:** el grupo se libera enseguida; delay por mensaje de hasta 15 minutos; el orden de escrituras (`RETRYING` antes del envío) permite recuperar un envío fallido con la re-entrega.
- **Negativas:** una Lambda y una cola más; los jobs siguientes del proveedor sí se ejecutan durante el backoff, lo que obliga a tener un circuit breaker (ADR-008); si la Requeue no puede reenviar, la fila queda `RETRYING` sin mensaje (la cubre la alarma de la DLQ de `retry`).

## Referencias

`src/core/execute/worker.ts`, `src/core/execute/requeue.ts`, `docs/05-errores-reintentos-circuit-breaker.md`
