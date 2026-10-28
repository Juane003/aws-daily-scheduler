# ADR-011: Aurora PostgreSQL con RDS Proxy y particiones por mes

- **Estado:** aceptada
- **Fecha:** 2026-10-28
- **Decisión de CLAUDE.md:** D11

## Contexto

Hay que guardar registros, ejecuciones y resultados: unos 365M de filas por año con 1M de registros (3.650M con 10M), con escrituras condicionales, conteos por estado y consultas de "lo que falta".

## Decisión

Aurora PostgreSQL detrás de RDS Proxy. `executions` y `results` particionadas por `RANGE (run_date)`, una partición por mes; retención con `DROP` de particiones (13 meses por defecto). Payloads de más de 256 KB a S3.

## Alternativas consideradas

- **DynamoDB:** escrituras condicionales sí, pero el anti-join del Reconciler y los conteos por estado y proveedor obligan a índices secundarios y contadores a mano.
- **Sin particiones:** la retención sería un `DELETE` de 30M (300M) de filas por mes, con bloat y carga de vacuum.
- **Sin RDS Proxy:** cientos de Lambdas abriendo conexiones directas agotarían las de Aurora.

## Consecuencias

- **Positivas:** `UNIQUE` + `ON CONFLICT` y `UPDATE ... WHERE ... RETURNING` resuelven la idempotencia y los claims; la retención es instantánea; las consultas calientes tocan una o dos particiones.
- **Negativas:** Aurora es el componente más caro de la estimación (`10-capacidad-y-costos.md`); hay que crear las particiones por adelantado (job mensual y alarma); con 10M el almacenamiento llega a ~7 TB en régimen si las respuestas son de ~1 KB.

## Referencias

`database/migrations/`, `docs/07-modelo-de-datos.md`
