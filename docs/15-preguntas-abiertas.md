# 15 — Preguntas abiertas

Preguntas que el enunciado no responde. Para cada una se indica el supuesto que adopta la implementación de referencia y qué cambiaría si la respuesta fuera otra. Este documento se completa a lo largo de las fases.

| #   | Pregunta                                            | Supuesto actual                                           | Impacto si cambia                                                                                                                                                                 |
| --- | --------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | ¿En qué zona horaria se define el "día de negocio"? | `BUSINESS_TZ=UTC` (configurable, validado como zona IANA) | Cambia el mapeo minuto → slot y el `run_date`. Con una zona con horario de verano hay días de 1.380 o 1.500 minutos: hay que definir qué pasa con los slots repetidos u omitidos. |

## Decisiones menores tomadas sin consultar

Decisiones no cubiertas por CLAUDE.md, resueltas con la opción más simple (§13).

- **Índice del Dispatcher.** CLAUDE.md §4 define `INDEX (slot) INCLUDE (id, provider_id) WHERE enabled`. La migración usa `(slot, id) INCLUDE (provider_id) WHERE enabled`: con `id` como segunda columna de la clave, la paginación keyset (`WHERE slot = $1 AND id > $cursor ORDER BY id LIMIT 1000`) recorre el índice en orden sin ordenar en memoria. Cubre las mismas columnas.
- **Visibility timeout de la FIFO.** Se deriva como `6 × WORKER_TIMEOUT_S` (§7) y se puede sobrescribir con `FIFO_VISIBILITY_TIMEOUT_S`, para poder validar la restricción `HTTP_TIMEOUT < WORKER_TIMEOUT < visibility`.
- **Invariantes extra de configuración.** Además de esa restricción, se valida al arrancar que `STALE_AFTER_S > WORKER_TIMEOUT_S` (si no, se podría re-reclamar un Worker vivo), `CB_BASE_COOLDOWN_S <= CB_MAX_COOLDOWN_S` y que `CB_MAX_COOLDOWN_S` y `RETRY_BASE_S` no superen 900 s, el máximo de `DelaySeconds` de SQS (a verificar en la documentación oficial de SQS).
- **Variables adicionales.** `ENQUEUED_STALE_S` (default 3 h), `RECONCILE_MAX_REQUEUE` (default 10.000) y `RETENTION_MONTHS` (default 13) se nombran en §4 y §6.6 pero no en §7; se agregaron con esos defaults.
- **Particiones.** Las funciones `ensure_monthly_partitions` y `drop_expired_partitions` (migración 005) crean y eliminan particiones mensuales. Quién las invoca (un job programado) es diseño objetivo.
- **Validación de migraciones.** No se corrieron todavía contra un PostgreSQL real; queda para `npm run test:db` (opcional, requiere Docker).
