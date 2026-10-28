# ADR-006: Event source mapping con BatchSize = 1 y MaximumConcurrency

- **Estado:** aceptada
- **Fecha:** 2026-10-28
- **Decisión de CLAUDE.md:** D6

## Contexto

El Worker consume la FIFO a través de un event source mapping (ESM) de Lambda. Hay que fijar cuántos mensajes recibe por invocación y cuántas invocaciones corren a la vez.

## Decisión

`BatchSize = 1` y `MaximumConcurrency` configurable. Cada invocación procesa un solo job: devolver OK es el ACK y una excepción deja el mensaje para re-entrega.

## Alternativas consideradas

- **Batches de 10 con `ReportBatchItemFailures`:** menos invocaciones, pero en una FIFO un fallo en el medio del batch obliga a devolver también los mensajes siguientes del mismo grupo (a verificar en la documentación de Lambda con SQS FIFO), y el manejo de errores parciales se complica.
- **Sin `MaximumConcurrency`:** el ESM escalaría hasta la concurrencia de la cuenta y podría saturar la API interna y Aurora.

## Consecuencias

- **Positivas:** un mensaje en vuelo por grupo equivale a una llamada en curso por proveedor; el manejo de errores es simple; `MaximumConcurrency` protege a la API interna (2 Lambdas por llamada) y a Aurora.
- **Negativas:** una invocación por job (30M por mes con 1M). `MaximumConcurrency` hay que dimensionarlo: ~127 Workers en promedio con 10M, y la ráfaga del comienzo de cada minuto le cuesta ~4% de capacidad a un proveedor saturado con 100 (`10-capacidad-y-costos.md`).

## Referencias

`src/handlers/worker.ts`, `src/simulation/harness.ts`, `docs/04-concurrencia-por-proveedor.md`
