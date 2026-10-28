# ADR-010: Reconciler cada hora

- **Estado:** aceptada
- **Fecha:** 2026-10-28
- **Decisión de CLAUDE.md:** D10

## Contexto

El lookback (ADR-003) cubre 5 minutos. Hace falta una red de seguridad para lo que quede: Workers caídos con el job reclamado, ventanas que no se recuperaron, registros que nunca se despacharon.

## Decisión

Una Lambda horaria que (1) re-encola las ejecuciones `IN_PROGRESS` stale con `seq + 1` y sin sumar intento, (2) inserta y encola los registros de slots vencidos (menos 10 minutos de margen) sin ejecución del día, incluida la cola del día anterior durante el período de gracia, (3) solo reporta los `ENQUEUED` de más de 3 h y (4) publica el porcentaje completado del día. Con un límite de 10.000 re-encolados por corrida.

## Alternativas consideradas

- **Recuperar recién al día siguiente:** el job perdería su día.
- **Reconciler cada pocos minutos:** recupera antes, pero hace consultas de todo el día con más frecuencia; el lookback ya cubre lo inmediato.
- **Re-encolar también los `ENQUEUED` viejos:** suele ser backlog legítimo de un proveedor caliente; re-encolarlo agregaría mensajes a una cola ya larga.

## Consecuencias

- **Positivas:** verificado en la integración (crashes antes y después de la llamada sin pérdidas ni duplicados); no toca terminales; el límite por corrida evita inundar la FIFO tras un incidente grande.
- **Negativas:** la recuperación de un Worker caído tarda hasta una hora; un día entero sin despachar necesita subir el límite a mano (`14-runbook.md`); las filas `RETRYING` huérfanas no las busca (pregunta abierta).

## Referencias

`src/core/reconcile/reconciler.ts`, `docs/06-idempotencia-y-consistencia.md`
