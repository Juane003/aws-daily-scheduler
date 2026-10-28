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
- **Puertos.** Los puertos viven en `src/core/ports.ts` y las filas del dominio en `src/core/model.ts`. El repositorio se divide en interfaces por tabla (`RegistryRepository`, `ExecutionRepository`, `DispatchWindowRepository`, `CircuitRepository`) para que cada componente declare solo lo que usa; el adaptador en memoria implementa todas.
- **El intento se cuenta en el claim.** `claimExecution` hace `attempt = attempt + 1` en el mismo `UPDATE` que pasa la fila a `IN_PROGRESS`. Un Worker que se cae a mitad de la llamada consume ese intento, y por eso el Reconciler re-encola los `IN_PROGRESS` stale sin sumar otro (§6.6). Los deferidos por el breaker no hacen claim y no cuentan.
- **Fencing token del claim.** Las transiciones posteriores al claim pueden condicionarse además a `started_at = <el valor escrito por el claim>`. Si el Reconciler re-encoló el job y otro Worker lo reclamó, las escrituras tardías del primero no aplican.
- **Éxito atómico.** `succeedExecution` escribe `results` (upsert) y marca `SUCCEEDED` en una sola transacción y solo si se cumple la condición; nunca queda un resultado sin el estado que lo acompaña.
- **Cursor del Reconciler.** Los registros sin ejecución del día se paginan por `(slot, id)`, el mismo orden del índice `(slot, id)` de `registries`.
- **`dispatch_windows.started_at`.** Al re-procesar una ventana (lookback) se conserva el `started_at` original, para que la alarma "ventana `PROCESSING` con más de 10 min" no se reinicie con cada reintento.
- **Slot actual ya `COMPLETED`.** El Dispatcher saltea cualquier ventana `COMPLETED`, también la del minuto actual. Un tick duplicado no hace nada. Un registro agregado a un slot ya despachado no corre ese día hasta que lo encole el Reconciler.
- **Recuperación de una ventana `PROCESSING`.** Al re-procesarla, el Dispatcher re-envía todas las filas del slot que siguen en `ENQUEUED`, no solo las que inserta: si no, un envío fallido después del `INSERT` dejaría el job sin encolar hasta que alguien lo detecte. Requiere la consulta `findEnqueuedExecutions(runDate, registryIds)`.
- **`jobs_dispatched`.** Es la cantidad de registros habilitados del slot que tienen ejecución del día al completar la ventana, y se escribe (no se suma). No cuenta mensajes, así que un re-envío no lo infla.
- **Reintentos de `SendMessageBatch`.** Hasta 3 reintentos de las entradas fallidas, sin espera entre intentos. Si se rechaza la llamada completa, cuenta como falla de todas sus entradas.
- **El Dispatcher no lanza.** Un error de base de datos o de envío en una ventana se registra (`DispatchFailures` y un log de error) y el tick sigue con los demás slots; el lookback del próximo tick reintenta.
- **Zona horaria.** `minuteOfDay` y `businessDate` usan `Intl.DateTimeFormat` con `businessTz` (con un camino directo para `UTC`). El comportamiento en los cambios de horario de verano se describe en `03-distribucion-diaria.md`.

### Fidelidad de los adaptadores en memoria

Los adaptadores reproducen la semántica de SQS que el diseño necesita, con estas simplificaciones (todas **a verificar** contra la documentación de SQS antes de implementar los adaptadores AWS):

- **FIFO:** entrega como máximo un mensaje por grupo en cada `receive`. SQS puede devolver varios mensajes del mismo grupo en un solo receive, pero con `BatchSize = 1` (D6) eso no ocurre. La deduplicación tiene alcance por grupo, como en modo high-throughput (D5), y la ventana de 5 min no se extiende con los duplicados.
- **Redrive:** un mensaje que ya se recibió `maxReceiveCount` veces se mueve a la DLQ en el siguiente receive, en lugar de entregarse.
- **Receipt handle vencido:** un `delete` con un handle que ya no es el último no borra el mensaje y devuelve `false` (no lanza).
- **Cola standard:** no inyecta entregas duplicadas ni desorden aleatorio. Los consumidores son idempotentes de todas formas (dedup de la FIFO más el claim).
- **Atomicidad del repositorio:** cada operación condicional se ejecuta sincrónicamente antes de resolver la promesa, de modo que dos llamadas concurrentes nunca ganan las dos. Equivale a un `UPDATE ... WHERE` en PostgreSQL, pero no modela niveles de aislamiento ni deadlocks.
