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
- **Status HTTP fuera de la tabla 6.4.** 1xx, 3xx y los 5xx que no están en la lista (501, 505, ...) se tratan como "error desconocido": `RETRYABLE`, acotado por `maxAttempts`.
- **Throttling de la API interna.** Se detecta por el header `x-amzn-ErrorType` (o `error.name`) con `TooManyRequestsException`, `ThrottlingException` o `LimitExceededException`, y gana sobre el status HTTP. Los valores exactos que devuelve la API interna quedan **a verificar** con el equipo dueño de la API.
- **`Retry-After`.** Se acepta en segundos o como fecha HTTP en formato IMF-fixdate. Un valor malformado se ignora y se usa el backoff. Se respeta tal cual (redondeado hacia arriba) con tope de `maxDelayS`, sin jitter adicional.
- **Breaker: resultados tardíos.** Un éxito o una falla que llega con el circuito `OPEN`, o en `HALF_OPEN` de otro dueño, se ignora: solo la llamada de prueba cierra o reabre el circuito.
- **Breaker: dueño de `HALF_OPEN` perdido.** En lugar de pasar la fila por `OPEN` vencida, el nuevo Worker toma la prueba en una sola transición (`HALF_OPEN → HALF_OPEN` con otro dueño). El efecto es el mismo y ahorra un `UPDATE`.
- **Breaker: defer en `HALF_OPEN`.** Los jobs que encuentran una prueba en curso se defieren `cbBaseCooldownS` (60 s), no hasta que venza el dueño.
- **Sharding del grupo FIFO.** Con `providerShards = k > 1`, el shard es `uint32(sha256(registryId)[4..8]) % k`: usa bytes distintos a los del slot para que el shard no quede correlacionado con el slot.
- **`registryId` en el mensaje.** Se transporta como string decimal (es un `BIGINT`) y el schema exige que `jobId` sea exactamente `${registryId}#${runDate}`.
