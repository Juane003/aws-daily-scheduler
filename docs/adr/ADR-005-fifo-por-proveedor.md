# ADR-005: SQS FIFO con un grupo por proveedor

- **Estado:** aceptada
- **Fecha:** 2026-10-28
- **Decisión de CLAUDE.md:** D5

## Contexto

El enunciado pide evitar la concurrencia hacia un mismo proveedor. Con cientos de Workers en paralelo, algo tiene que garantizar que dos llamadas al mismo proveedor no se solapen.

## Decisión

Una cola SQS FIFO en modo high-throughput con `MessageGroupId = providerId` (o `providerId#shard` con `providerShards = k > 1`) y `MessageDeduplicationId = jobId#seq`. SQS no entrega un mensaje de un grupo mientras otro del mismo grupo esté en vuelo.

## Alternativas consideradas

- **Locks distribuidos (Redis, DynamoDB) o `SKIP LOCKED`:** un componente o una conexión más, TTLs y casos de dueño caído; el job que no consigue el lock no tiene dónde esperar.
- **Una cola por proveedor:** miles de colas y ESM como infraestructura dependiente de los datos.
- **Kinesis particionado por proveedor:** varios proveedores comparten shard y uno lento frena a los demás.

## Consecuencias

- **Positivas:** exclusión mutua sin estado propio, verificada en la integración (pico de 1 llamada por proveedor con 400 registros y 8 proveedores; con `k = 4` el pico es 4); un proveedor con backlog no afecta a los demás grupos; deduplicación de 5 minutos.
- **Negativas:** el techo diario de un proveedor es `86.400 / latencia` (simulado: 144.056 llamadas contra 144.000 predichas); los reintentos no pueden quedarse en la FIFO sin bloquear el grupo (ADR-007); FIFO cuesta más por request que una cola standard.

## Referencias

`src/common/message.ts`, `src/adapters/memory/fifo-queue.ts`, `docs/04-concurrencia-por-proveedor.md`
