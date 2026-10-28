# ADR-002: EventBridge Scheduler cada minuto invoca al Dispatcher

- **Estado:** aceptada
- **Fecha:** 2026-10-28
- **Decisión de CLAUDE.md:** D2

## Contexto

Con el slot de cada registro definido (ADR-001), algo tiene que disparar el despacho de cada minuto.

## Decisión

Un único EventBridge Scheduler con frecuencia de 1 minuto invoca a la Dispatcher Lambda, que despacha el slot del minuto actual.

## Alternativas consideradas

- **Un schedule por registro:** obliga a sincronizar 1M+ schedules con la base y no resuelve la concurrencia por proveedor (`11-alternativas-descartadas.md`).
- **Un proceso permanente (ECS) con un loop:** funciona, pero agrega un servicio siempre encendido para un trabajo de segundos por minuto.

## Consecuencias

- **Positivas:** una sola pieza de programación para toda la plataforma; la base es la única fuente de verdad; costo despreciable (~44.000 invocaciones por mes, dentro del nivel gratuito).
- **Negativas:** EventBridge puede invocar dos veces o saltear un tick: lo cubren la idempotencia del despacho (ADR-004) y el lookback (ADR-003). La granularidad es de un minuto.

## Referencias

`src/core/dispatch/dispatcher.ts`, `docs/02-arquitectura.md`
