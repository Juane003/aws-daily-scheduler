# 11 — Alternativas descartadas

Para cada pieza del diseño hubo otras opciones razonables. Este documento explica por qué no se eligieron y en qué caso convendría reconsiderarlas.

## Programación: un schedule de EventBridge por registro

**La idea:** crear un schedule de EventBridge Scheduler por registro, con su propio horario, que invoque directamente al Worker.

**Por qué no:**

- **Sincronización con la base.** Cada alta, baja o cambio en `registries` obliga a crear, borrar o actualizar un schedule. Con 1M (y 10M) de registros, mantener dos fuentes de verdad consistentes es un problema en sí mismo: un schedule huérfano corre para siempre; uno faltante nunca corre, y nadie lo nota.
- **Cuotas.** La cantidad de schedules por cuenta y la tasa de llamadas a la API de Scheduler tienen límites (**a verificar** en las cuotas de EventBridge Scheduler) que habría que ampliar para 10M.
- **No resuelve la concurrencia por proveedor:** cada schedule invoca de forma independiente, así que haría falta un lock aparte.
- **Costo:** con 10M de invocaciones diarias, el cobro por invocación de Scheduler supera ampliamente al de un único schedule por minuto (300M por mes contra ~44.000).

**Elegido (D1, D2):** un único schedule por minuto y el slot persistido en la tabla. La base es la única fuente de verdad.

## Concurrencia: `SELECT ... FOR UPDATE SKIP LOCKED` sobre la base

**La idea:** Workers que toman jobs de una tabla con `SKIP LOCKED`, sin colas.

**Por qué no:**

- **La exclusión por proveedor no sale gratis.** `SKIP LOCKED` reparte filas, no proveedores: para garantizar una llamada por proveedor habría que tomar además un lock por proveedor (advisory lock o fila de control) y mantenerlo durante la llamada HTTP, con una conexión abierta por cada Worker en curso.
- **Polling.** Sin colas, los Workers consultan la base en un loop: carga constante en Aurora incluso sin trabajo, y una latencia que depende del intervalo de polling.
- **Reintentos con delay, DLQ y visibilidad** habría que construirlos sobre la tabla; SQS los da hechos.

**Cuándo reconsiderarlo:** con volúmenes mucho más chicos, donde una sola tabla y un proceso simplifican la operación.

## Concurrencia: lock distribuido en Redis o DynamoDB

**La idea:** un lock por proveedor (Redis `SET NX PX` o un ítem de DynamoDB con escritura condicional y TTL) que el Worker toma antes de llamar.

**Por qué no:**

- **Un componente más** para algo que la FIFO resuelve sin estado propio.
- **El lock no ordena la espera.** Un Worker que no consigue el lock tiene que hacer algo con el job: reintentarlo después (más mensajes y más latencia) o esperar ocupando una Lambda. Con la FIFO, el job simplemente no se entrega hasta que el grupo se libera.
- **Los casos borde son peores:** TTL más corto que la llamada (dos llamadas a la vez), TTL largo con un Worker caído (proveedor bloqueado hasta que vence), renovaciones.

**Elegido (D5):** grupo FIFO por proveedor; el visibility timeout cumple el rol del TTL y la re-entrega es automática.

## Orquestación: Step Functions

**La idea:** una ejecución de Step Functions por job (o un Map distribuido por día) con reintentos, esperas y manejo de errores declarativos.

**Por qué no:**

- **Costo por transición.** Con varias transiciones por job y 30M (o 300M) de jobs por mes, el cobro de Standard Workflows supera ampliamente al resto de la arquitectura (**a verificar** con la calculadora; Express Workflows es más barato pero limita la duración y la visibilidad).
- **No resuelve la concurrencia por proveedor.** Haría falta igual un mecanismo de exclusión.
- **El flujo es corto y lineal:** llamar, clasificar, guardar. La lógica de reintentos está en ~300 líneas testeadas; un orquestador no agrega mucho.

**Cuándo reconsiderarlo:** si cada job pasara a ser un flujo de varios pasos con esperas largas o aprobaciones.

## Transporte: Kinesis Data Streams

**La idea:** un stream particionado por proveedor; un consumidor por shard procesa en orden.

**Por qué no:**

- **La concurrencia queda atada a los shards, no a los proveedores.** Varios proveedores comparten shard: un proveedor lento frena a todos los demás de su shard (head-of-line blocking). Con la FIFO cada proveedor tiene su propio grupo.
- **Reintentos:** un registro que falla bloquea el shard hasta que se resuelve o se descarta; no hay delay por mensaje ni DLQ nativa del mismo modo.
- **Costo fijo por shard-hora** aunque no haya tráfico.

**Cuándo reconsiderarlo:** para procesar los resultados en streaming hacia otros sistemas, no para ejecutar las consultas.

## Colas: una cola por proveedor

**La idea:** una cola SQS (standard) por proveedor, con un consumidor de concurrencia 1 por cola.

**Por qué no:**

- **2.000+ colas y 2.000+ event source mappings** que crear, monitorear y borrar a medida que aparecen proveedores. La infraestructura dependería de los datos.
- **La concurrencia de cada ESM tiene un mínimo** mayor que 1 (**a verificar**: `MaximumConcurrency` del ESM de SQS tiene un mínimo de 2), así que tampoco garantiza una llamada por proveedor sin otro mecanismo.

**Elegido (D5):** una sola FIFO con un grupo por proveedor: la cardinalidad de proveedores es un dato, no infraestructura.

## Reintentos: en la misma FIFO

**La idea:** ante un error reintentable, no hacer ACK y dejar que la FIFO lo re-entregue al vencer el visibility timeout (o usar `ChangeMessageVisibility` para fijar el delay).

**Por qué no:**

- **Bloquea al proveedor durante todo el backoff.** Mientras el mensaje está en vuelo, el grupo no entrega nada más: un job en backoff de 10 minutos frena a todos los jobs del proveedor.
- **El delay queda acotado por el visibility timeout** y el conteo de recepciones lo maneja SQS, que manda el mensaje a la DLQ tras `maxReceiveCount` sin distinguir tipos de error.
- **Las FIFO no admiten `DelaySeconds` por mensaje** (solo por cola; **a verificar** en la documentación de SQS).

**Elegido (D7):** cola standard `retry` con `DelaySeconds` por mensaje y una Lambda Requeue. El costo: una Lambda más, y que los jobs siguientes del proveedor sí se ejecutan (de ahí el circuit breaker, D8). Detalle en `05-errores-reintentos-circuit-breaker.md`.

## Distribución: tabla diaria materializada a medianoche

**La idea:** a las 00:00, un proceso genera la lista del día (1M de filas en `executions` con su horario) y los Workers la consumen a lo largo del día.

**Por qué no:**

- **Un pico de escrituras a medianoche:** 1M (10M) de `INSERT` de golpe, justo cuando el día empieza, en lugar de ~700 por minuto.
- **Un punto único de falla diario.** Si el proceso de medianoche falla o tarda, el día entero se atrasa; hay que detectarlo y re-ejecutarlo a tiempo.
- **Los cambios del día no se ven:** un registro agregado a las 10:00 no está en la lista.

**Elegido (D4):** la ejecución se registra cuando se despacha, minuto a minuto. Lo encolado y nunca procesado sigue siendo visible (`ENQUEUED`), y las escrituras se reparten en el día.

## Base de datos: DynamoDB

**La idea:** `executions` y `results` en DynamoDB, con escrituras condicionales para el claim y TTL para la retención.

**Por qué no (para esta carga):**

- El Reconciler necesita "registros de slots vencidos **sin** ejecución del día": un anti-join que en DynamoDB obliga a leer todo y comparar en la aplicación.
- Los conteos por estado y proveedor (`DailyCompletionPct`, `PendingByProvider`) requieren índices secundarios o contadores mantenidos a mano.
- La tabla del enunciado ya es relacional y probablemente vive en una base relacional.

**Cuándo reconsiderarlo:** si `executions` y `results` superaran lo que Aurora maneja cómodamente, separar `results` (escritura sola, lectura por clave) a DynamoDB o S3 es la primera opción.
