# ADR-012: Idempotencia de punta a punta

- **Estado:** aceptada
- **Fecha:** 2026-10-28
- **Decisión de CLAUDE.md:** D12

## Contexto

SQS entrega at-least-once, EventBridge puede repetir un tick y cualquier Lambda puede caerse entre dos pasos. Un job no puede perderse ni producir efectos duplicados.

## Decisión

`jobId = registryId#runDate` determinístico; `UNIQUE(registry_id, run_date)`; `MessageDeduplicationId = jobId#seq`; claim condicional en el Worker (`UPDATE ... WHERE status IN (ENQUEUED, RETRYING) OR stale RETURNING`), con `started_at` como fencing token para las escrituras posteriores; y el header `Idempotency-Key: jobId` hacia la API interna.

## Alternativas consideradas

- **Exactly-once con transacciones distribuidas:** no existe entre SQS, Lambda y una API HTTP.
- **Ids aleatorios por ejecución:** imposible detectar duplicados entre despachos.

## Consecuencias

- **Positivas:** cada capa descarta un tipo de duplicado distinto (`06-idempotencia-y-consistencia.md`); los escenarios de crash están cubiertos por tests.
- **Negativas:** queda una ventana de duplicación hacia el proveedor si el Worker se cae después de la llamada y la API no respeta `Idempotency-Key` (pregunta P3); el intento se cuenta en el claim, así que un crash antes de la llamada consume un intento.

## Referencias

`src/core/execute/worker.ts`, `src/adapters/memory/repository.ts`, `docs/06-idempotencia-y-consistencia.md`
