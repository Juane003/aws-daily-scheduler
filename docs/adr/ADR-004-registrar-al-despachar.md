# ADR-004: La ejecución se registra al despachar

- **Estado:** aceptada
- **Fecha:** 2026-10-28
- **Decisión de CLAUDE.md:** D4

## Contexto

Hay que decidir cuándo nace la fila de `executions` de cada job: al comienzo del día para todos, o a medida que se despachan.

## Decisión

El Dispatcher inserta la ejecución en estado `ENQUEUED` en el mismo tick en que la encola, con `INSERT ... ON CONFLICT DO NOTHING RETURNING registry_id`, y envía a la FIFO **solo** las filas que insertó.

## Alternativas consideradas

- **Tabla diaria materializada a medianoche:** un pico de 1M (10M) de escrituras a las 00:00, un punto único de falla diario y registros nuevos que no aparecen hasta el día siguiente.
- **Registrar recién en el Worker:** no se vería lo encolado y nunca procesado.

## Consecuencias

- **Positivas:** el despacho es idempotente (un tick duplicado no inserta ni encola nada); las escrituras se reparten en el día; `ENQUEUED` hace visible el backlog real (métrica `EnqueuedStale`).
- **Negativas:** si el envío falla después del `INSERT`, la fila queda `ENQUEUED` sin mensaje; lo cubren el re-envío de ventanas `PROCESSING` (ADR-003) y el reporte de `ENQUEUED` viejos (ADR-010).

## Referencias

`src/core/dispatch/dispatcher.ts`, `docs/06-idempotencia-y-consistencia.md`
