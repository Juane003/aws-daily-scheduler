# ADR-008: Circuit breaker por proveedor en Aurora

- **Estado:** aceptada
- **Fecha:** 2026-10-28
- **Decisión de CLAUDE.md:** D8

## Contexto

Como los reintentos liberan el grupo (ADR-007), un proveedor caído seguiría recibiendo una llamada tras otra de los jobs siguientes, cada una con su timeout y su reintento.

## Decisión

Un breaker por proveedor persistido en `provider_circuits`. `CLOSED` pasa a `OPEN` tras 5 fallas reintentables consecutivas, por un cooldown de 60 s que se duplica en cada prueba fallida hasta 900 s. Vencido el cooldown, un único Worker gana la transición a `HALF_OPEN` y hace la llamada de prueba. Mientras está abierto, los jobs se difieren a `retry` sin consumir intentos. Los 4xx no cuentan. La lógica es una función pura; el adaptador persiste con compare-and-set.

## Alternativas consideradas

- **Breaker en memoria de cada Lambda:** cada instancia tendría su propio estado, sin coordinación.
- **Breaker en Redis o DynamoDB:** otro componente; Aurora ya está y el breaker escribe solo cuando su estado cambia.
- **Sin breaker, solo backoff:** cada job seguiría golpeando al proveedor caído por lo menos una vez.

## Consecuencias

- **Positivas:** verificado en la integración (con 100% de 503, ninguna llamada durante los intervalos `OPEN`); la carrera por la prueba la resuelve la base y solo uno gana; un 4xx en la prueba cierra el circuito, porque el proveedor respondió.
- **Negativas:** una lectura de `provider_circuits` por job; los jobs diferidos pueden vencer si el proveedor sigue caído hasta el deadline (es lo esperable, y queda visible en la DLQ).

## Referencias

`src/common/circuit-breaker.ts`, `src/core/execute/circuit.ts`, `docs/05-errores-reintentos-circuit-breaker.md`
