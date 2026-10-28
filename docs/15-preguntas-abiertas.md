# 15 — Preguntas abiertas

Preguntas que el enunciado no responde. Para cada una se indica el supuesto que adopta la implementación de referencia y qué cambiaría si la respuesta fuera otra. Este documento se completa a lo largo de las fases.

| #   | Pregunta                                            | Supuesto actual                                | Impacto si cambia                                                                                                                                                                 |
| --- | --------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | ¿En qué zona horaria se define el "día de negocio"? | `businessTz = 'UTC'` (parámetro en `defaults`) | Cambia el mapeo minuto → slot y el `run_date`. Con una zona con horario de verano hay días de 1.380 o 1.500 minutos: hay que definir qué pasa con los slots repetidos u omitidos. |

## Decisiones menores tomadas sin consultar

Decisiones no cubiertas por CLAUDE.md, resueltas con la opción más simple (§13).

- **Índice del Dispatcher.** CLAUDE.md §4 define `INDEX (slot) INCLUDE (id, provider_id) WHERE enabled`. La migración usa `(slot, id) INCLUDE (provider_id) WHERE enabled`: con `id` como segunda columna de la clave, la paginación keyset (`WHERE slot = $1 AND id > $cursor ORDER BY id LIMIT 1000`) recorre el índice en orden sin ordenar en memoria. Cubre las mismas columnas.
- **Parámetros.** Los valores de §7 viven en un único objeto `defaults` (`src/common/config.ts`) que cada componente recibe por constructor. No se leen variables de entorno ni se validan al arrancar: en producción vendrían de variables de entorno definidas en la IaC (diseño objetivo). La relación `httpTimeoutMs < workerTimeoutS < visibilityTimeoutS` se cubre con un test sobre `defaults`.
- **Retención.** Los 13 meses de §4 no son un parámetro de TypeScript: se pasan como argumento `retention_months` a `drop_expired_partitions` (migración 005) desde el job que la invoque.
- **Particiones.** Las funciones `ensure_monthly_partitions` y `drop_expired_partitions` (migración 005) crean y eliminan particiones mensuales. Quién las invoca (un job programado) es diseño objetivo.
- **Validación de migraciones.** No se corrieron todavía contra un PostgreSQL real; queda para `npm run test:db` (opcional, requiere Docker).
