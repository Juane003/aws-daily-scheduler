# ADR-003: Ventanas de despacho y lookback de 5 slots

- **Estado:** aceptada
- **Fecha:** 2026-10-28
- **Decisión de CLAUDE.md:** D3

## Contexto

Un tick puede no ejecutarse (falla de EventBridge, Lambda caída, throttling) o fallar a mitad de camino. Sin un registro de qué minutos se despacharon, esos registros esperarían al Reconciler horario (ADR-010).

## Decisión

El Dispatcher registra cada minuto en `dispatch_windows(run_date, slot, status)`. En cada tick procesa el slot actual y los 5 anteriores que no estén `COMPLETED`, cruzando medianoche con el `run_date` del día anterior. Una ventana con envíos fallidos queda en `PROCESSING` y se retoma en el tick siguiente, re-enviando las filas que siguen `ENQUEUED`.

## Alternativas consideradas

- **Sin lookback, solo Reconciler:** recuperación de hasta una hora en lugar de un minuto.
- **Lookback más largo:** recupera caídas más largas sin esperar al Reconciler, a costa de más lecturas por tick cuando una falla es persistente.

## Consecuencias

- **Positivas:** un tick perdido se recupera en el siguiente minuto; la ventana `PROCESSING` hace visible un despacho incompleto (alarma de 10 minutos); el re-envío de filas `ENQUEUED` cubre el caso "insertado pero no enviado".
- **Negativas:** 5 lecturas extra de `dispatch_windows` por tick; en el primer despliegue el lookback despacha los últimos slots del día anterior.

## Referencias

`src/core/dispatch/dispatcher.ts`, `docs/03-distribucion-diaria.md`
