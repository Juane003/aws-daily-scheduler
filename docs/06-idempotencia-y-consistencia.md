# 06 — Idempotencia y consistencia

SQS entrega **at-least-once**: un mensaje puede llegar dos veces, y cualquier Lambda puede caerse entre dos pasos. Este documento explica por qué eso no produce jobs perdidos ni efectos duplicados. Código: `src/core/execute/worker.ts`, `src/core/dispatch/dispatcher.ts`, `src/adapters/memory/repository.ts`. Decisión: D12.

> Implementación de referencia: los escenarios de este documento están cubiertos por tests unitarios con adaptadores en memoria (`tests/unit/worker.test.ts`, `tests/unit/dispatcher.test.ts`). Los crashes simulados de punta a punta llegan con la integración (fase 7). Nada fue probado en AWS.

## 1. Identidad del job

```
jobId = registryId#runDate
```

Es **determinístico**: el mismo registro el mismo día de negocio siempre produce el mismo `jobId`, lo despache quien lo despache (Dispatcher, lookback o Reconciler). Sobre esa identidad se apoyan todas las capas:

| Capa                        | Mecanismo                                                                            | Qué evita                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| 1. Base de datos            | `PRIMARY KEY (registry_id, run_date)` + `INSERT ... ON CONFLICT DO NOTHING`          | Dos ejecuciones del mismo registro el mismo día                                                      |
| 2. FIFO                     | `MessageDeduplicationId = jobId#seq`, ventana de 5 min                               | Dos copias del mismo envío (reintento del `SendMessageBatch`, re-envío de una ventana recuperada)    |
| 3. Claim del Worker         | `UPDATE ... SET IN_PROGRESS WHERE status IN (ENQUEUED, RETRYING) OR stale RETURNING` | Dos Workers procesando el mismo job: solo uno gana; el otro hace ACK sin llamar                      |
| 4. Fencing con `started_at` | Las escrituras posteriores al claim exigen `started_at = <valor del claim>`          | Que un Worker lento escriba encima de otro que retomó el job por stale                               |
| 5. API interna              | Header `Idempotency-Key: jobId`                                                      | Efecto duplicado en el proveedor si la llamada se repite (**sujeto a que la API respete el header**) |

**Por qué `seq` en el dedup id y no solo `jobId`:** un reintento legítimo del mismo job (tras un 503 o un defer del breaker) es un mensaje nuevo y no debe descartarse. `seq` cuenta los re-encolados; `attempt` cuenta las llamadas reales. Un defer del breaker sube `seq` pero no `attempt`.

**Por qué el intento se cuenta en el claim:** el `UPDATE` del claim hace `attempt = attempt + 1`. Si el Worker se cae a mitad de la llamada, ese intento ya está contado y el job no puede reintentarse indefinidamente. El costo es contar como intento una llamada que quizás no llegó a salir; está acotado por `maxAttempts`.

## 2. Orden de escrituras en el Worker

Regla de §3: antes de hacer ACK, el job ya tiene que estar en `retry` o en la DLQ si corresponde; si ese envío falla, el Worker lanza la excepción y la FIFO re-entrega el mensaje. El orden entre "escribir el estado" y "enviar el mensaje" no es el mismo en todas las ramas:

| Rama                                         | Orden                                          | Por qué                                                                                                                                                                                            |
| -------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Terminal (no reintentable, agotado, vencido) | **DLQ primero**, después el estado terminal    | Si se escribiera primero el estado y fallara el envío, la re-entrega encontraría una fila terminal, haría ACK y la carta a la DLQ se perdería. Al revés, un reenvío a la DLQ lo descarta el dedup. |
| Reintento y defer del breaker                | **Estado `RETRYING` primero**, después `retry` | Si falla el envío, la re-entrega puede hacer claim de la fila `RETRYING` y reintentar. Al revés, una fila que quedara `IN_PROGRESS` solo la rescataría el Reconciler (6 min o más).                |
| Éxito                                        | `results` + `SUCCEEDED` en **una transacción** | Nunca hay un resultado sin su estado ni un `SUCCEEDED` sin resultado.                                                                                                                              |

## 3. Escenarios de falla

### Crash del Worker antes de la llamada

1. El Worker hace claim (`IN_PROGRESS`, `attempt = 1`, `started_at = t`) y se cae antes de llamar a la API.
2. No hubo ACK: el mensaje vuelve a ser visible al vencer el visibility timeout (180 s). Mientras tanto el grupo del proveedor queda bloqueado (un mensaje en vuelo por grupo).
3. La re-entrega intenta el claim: la fila está `IN_PROGRESS` y no es stale (`staleAfterS = 360`), así que hace **ACK sin llamar**.
4. El Reconciler (cada hora) encuentra la fila `IN_PROGRESS` con `started_at < now - 360 s`, la pasa a `RETRYING` y la re-encola con `seq + 1` sin sumar intento.

**Resultado:** el job se ejecuta, con un intento "gastado". No se pierde ni se duplica. La latencia de recuperación la pone el Reconciler (hasta ~1 h). Alternativa considerada: dejar que la re-entrega retome la fila stale en lugar de hacer ACK; se descartó porque la re-entrega llega a los 180 s, antes de que la fila sea stale, y esperar bloquearía el grupo del proveedor.

### Crash del Worker después de la llamada

1. Claim, llamada exitosa a la API, y el Worker se cae antes de escribir `results`.
2. Igual que el caso anterior: la re-entrega hace ACK y el Reconciler re-encola el job.
3. El siguiente Worker vuelve a llamar a la API **con el mismo `Idempotency-Key`**. Si la API lo respeta, devuelve el resultado original sin repetir el efecto. Si no lo respeta, el proveedor recibe dos llamadas para el mismo día: es la única ventana de duplicación del diseño y depende de la pregunta abierta sobre `Idempotency-Key` (`15-preguntas-abiertas.md`).

### Worker lento que pierde el claim

1. El Worker A hace claim en `t` y la llamada tarda más que `staleAfterS`.
2. El Reconciler (o un claim por stale) le entrega el job al Worker B, con `started_at = t'`.
3. Cuando A termina, su `succeedExecution` exige `started_at = t`: no aplica. A devuelve `CLAIM_LOST` y hace ACK sin escribir. El resultado de B es el que queda.

En la configuración por defecto esto no debería ocurrir: `httpTimeoutMs (10 s) < workerTimeoutS (30 s) < visibilityTimeoutS (180 s) < staleAfterS (360 s)`.

### Envío fallido a `retry`

1. La llamada devuelve 503. El Worker escribe `RETRYING` y el envío a `retry` falla.
2. El Worker lanza: no hay ACK y el mensaje vuelve a la FIFO a los 180 s.
3. La re-entrega hace claim de la fila `RETRYING` (`attempt = 2`) y llama de nuevo, sin el backoff que correspondía. El reintento llega antes de lo previsto pero acotado por `maxAttempts` y por el breaker.

### Envío fallido a la DLQ

1. La llamada devuelve 404. El envío a la DLQ falla antes de escribir `FAILED_NON_RETRYABLE`.
2. El Worker lanza; la fila queda `IN_PROGRESS`. La re-entrega hace ACK (claim fallido) y el Reconciler re-encola el job cuando queda stale; el nuevo intento vuelve a recibir 404 y esta vez llega a la DLQ.
3. Si la DLQ sigue fallando, cada corrida del Reconciler repite el ciclo con un intento más, hasta que el envío funcione, se agote `maxAttempts` o venza el deadline. Mientras tanto el job queda visible como `IN_PROGRESS` en la base y la alarma de `DispatchFailures`/DLQ no ayuda (el mensaje no llegó): la señal es el log de error del Worker y la métrica de errores de la Lambda.

### Tick duplicado del Dispatcher

1. EventBridge invoca dos veces el mismo minuto (o el lookback re-procesa una ventana).
2. Si la ventana está `COMPLETED`, el segundo tick la saltea.
3. Si está `PROCESSING` (la primera corrida falló a mitad), el `INSERT ... ON CONFLICT DO NOTHING` no inserta nada nuevo y el Dispatcher re-envía las filas que siguen `ENQUEUED` con `MessageDeduplicationId = jobId#0`: la FIFO descarta las que ya se habían enviado en los últimos 5 minutos y el claim descarta las demás.

### Mensaje duplicado en la FIFO o en `retry`

La cola `retry` es standard y puede entregar dos veces. Las dos copias llegan a la FIFO con el mismo `jobId#seq` y la segunda se descarta por dedup si llega dentro de 5 minutos. Si llega después, el claim la descarta (`DUPLICATE`) porque el job ya está `IN_PROGRESS` o terminado.

### Mensaje inválido

Un body que no valida contra el schema de `zod` va a la DLQ con `reason = 'INVALID_MESSAGE'` y el body original en `raw`. Nunca se descarta en silencio.

## 4. Formato de la DLQ

```ts
interface DeadLetter {
  reason: 'INVALID_MESSAGE' | 'NON_RETRYABLE' | 'EXHAUSTED' | 'EXPIRED';
  error?: string; // last_error_type, o el error de validación
  failedAt: string; // ISO 8601
  message?: JobMessage; // el job, si se pudo parsear
  raw?: string; // el body original, si no
}
```

Los poison messages que mueve la redrive policy de SQS (tras `maxReceiveCount` entregas sin ACK) llegan como un `JobMessage` sin sobre. La herramienta de redrive (`14-runbook.md`) acepta los dos formatos.
