# 03 — Distribución diaria

Cómo se reparte una consulta por registro a lo largo del día, cómo se despacha cada minuto y cómo se recupera un minuto perdido. Código: `src/common/slot.ts`, `src/common/time.ts`, `src/core/dispatch/dispatcher.ts`. Decisiones: D1 a D4.

## Slot wheel (D1)

El día de negocio tiene 1.440 minutos. Cada registro tiene un **slot** fijo:

```
slot = uint32(sha256(registryId)[0..4]) % 1440
```

El slot se calcula una vez y se persiste en `registries.slot`. El Dispatcher del minuto `m` despacha los registros con `slot = m`.

**Por qué así:**

- **Uniforme sin coordinación.** sha256 reparte ids consecutivos (o con cualquier patrón) de forma pareja; no hace falta un proceso que asigne minutos ni que re-balancee.
- **Estable.** El mismo registro corre todos los días en el mismo minuto, lo que hace predecible la carga y facilita investigar un caso ("el registro X corre a las 14:07").
- **Un solo schedule (D2).** Con el slot en la tabla, un único EventBridge Scheduler por minuto alcanza para toda la plataforma. La alternativa (un schedule por registro) implica sincronizar 1M+ schedules contra la base (ver `11-alternativas-descartadas.md`).
- **Persistido, no recalculado.** El índice `(slot, id) INCLUDE (provider_id) WHERE enabled` hace que la consulta del minuto sea un recorrido de índice. Si en el futuro se quisiera mover un registro de minuto (por ejemplo, para aliviar un proveedor caliente), alcanza con un `UPDATE` del slot.

**Trade-off:** el slot no tiene en cuenta el proveedor. Un proveedor con muchos registros los recibe repartidos al azar en el día, y su techo lo pone la FIFO (ver `04-concurrencia-por-proveedor.md`), no el slot.

### Jobs por minuto

Valores **calculados** aplicando la función de slot a los ids `1..N` (no es una medición en AWS):

| Registros | Promedio por minuto | Mínimo | Máximo | Desvío estándar | Máximo / promedio |
| --------- | ------------------- | ------ | ------ | --------------- | ----------------- |
| 1M        | 694,4               | 585    | 787    | 26,4            | 1,13              |
| 10M       | 6.944,4             | 6.709  | 7.226  | 81,2            | 1,04              |

La simulación de escala (`npm run simulate`, ver `04-concurrencia-por-proveedor.md`) obtiene exactamente los mismos valores para 1M a partir de las ventanas que completó el Dispatcher (`dispatch_windows.jobs_dispatched`): el Dispatcher despacha lo que el slot wheel reparte. Para 10M los valores son calculados; la simulación de 10M no se corrió (ver `15-preguntas-abiertas.md`).

El desvío coincide con el de una distribución binomial (`√(N · 1/1440)` ≈ 26 para 1M y ≈ 83 para 10M), que es lo esperable de un hash uniforme. El test `tests/unit/slot.test.ts` lo verifica con chi-cuadrado sobre 1M de ids (p > 0,01).

Qué implica por tick:

| Registros | Páginas de 1.000 | `SendMessageBatch` (10 por batch) | Mensajes por segundo (promedio) |
| --------- | ---------------- | --------------------------------- | ------------------------------- |
| 1M        | 1                | ~70                               | ~11,6                           |
| 10M       | 7                | ~695                              | ~116                            |

Los límites de throughput de SQS FIFO en modo high-throughput y la duración de un tick con 10M contra Aurora real están **a verificar** (documentación de cuotas de SQS y una prueba en un ambiente real); la implementación de referencia no los mide.

## Dispatcher por tick (D2–D4)

```mermaid
sequenceDiagram
  participant EB as EventBridge (1 min)
  participant D as Dispatcher
  participant DB as Aurora
  participant F as SQS FIFO
  EB->>D: tick
  loop slot-5 .. slot-1 (lookback) y slot actual
    D->>DB: dispatch_windows(runDate, s)
    alt COMPLETED
      D-->>D: saltear
    else no existe o PROCESSING
      D->>DB: upsert PROCESSING
      loop páginas de 1.000 por (slot, id)
        D->>DB: INSERT executions ENQUEUED ON CONFLICT DO NOTHING RETURNING
        D->>F: SendMessageBatch (solo insertados; 10 por batch, 10 en paralelo)
      end
      alt todo enviado
        D->>DB: COMPLETED, jobs_dispatched
      else quedaron envíos fallidos
        D-->>D: dejar PROCESSING + métrica DispatchFailures
      end
    end
  end
```

**La ejecución se registra antes de encolar (D4).** El `INSERT ... ON CONFLICT DO NOTHING RETURNING` es lo que hace idempotente al tick: si el minuto se procesa dos veces, la segunda vez no inserta nada y no encola nada. Además, el estado `ENQUEUED` deja visible lo que se encoló y nunca se procesó, y las escrituras quedan repartidas en el día en lugar de concentrarse en un pico a medianoche.

**Reintentos del envío.** Las entradas que `SendMessageBatch` rechaza se reintentan hasta 3 veces (sin espera entre intentos en la implementación de referencia; en AWS convendría un backoff corto). Si alguna sigue fallando, la ventana queda en `PROCESSING`, se emite `DispatchFailures` y se continúa con las demás páginas y slots: un error no frena el tick.

**El handler no lanza.** Una ventana fallida se recupera en el próximo tick por lookback, que es más rápido que un reintento de EventBridge del tick completo.

## Lookback (D3)

En cada tick, además del slot actual, se revisan los `lookbackSlots = 5` anteriores. Los que no estén `COMPLETED` (porque el tick no corrió, el Dispatcher se cayó o un envío falló) se procesan con `reason = LOOKBACK`.

- **Cruce de medianoche.** A las 00:02 los slots anteriores son 1437, 1438 y 1439 **del día anterior** y 0 y 1 del día actual. El `runDate` de cada uno es el de su día: un registro del slot 1439 corrido a las 00:02 pertenece al día anterior.
- **Recuperación de una ventana `PROCESSING`.** Si una corrida anterior insertó filas pero no llegó a enviarlas, el `INSERT` de la nueva corrida no devuelve nada (ya existen). Por eso, cuando la ventana ya existía en `PROCESSING`, el Dispatcher re-envía todas las filas de la página que siguen en `ENQUEUED`. Lo que ya se había enviado hace menos de 5 minutos lo descarta la deduplicación de la FIFO (mismo `MessageDeduplicationId = jobId#0`); lo más viejo lo descarta el claim del Worker. El costo es, como mucho, un mensaje duplicado que termina en ACK sin llamar a la API.
- **Más allá de 5 minutos** la red de seguridad es el Reconciler (D10, cada hora), que encola los registros de slots vencidos sin ejecución del día.

**Por qué 5 slots:** cubre ticks perdidos y caídas cortas con una latencia de recuperación de 1 minuto, y acota el trabajo extra por tick a 5 lecturas de `dispatch_windows` cuando todo está bien. Un valor más grande recupera caídas más largas sin esperar al Reconciler, a costa de más trabajo por tick si la falla es persistente.

## Día de negocio

`businessTz` (default `UTC`) define qué minuto es cada instante y a qué `runDate` pertenece. Con UTC todos los días tienen 1.440 minutos. Con una zona con horario de verano hay días de 1.380 o 1.500 minutos: en el día corto se saltean 60 slots (el lookback de 5 no los cubre; los toma el Reconciler) y en el largo una hora de slots se repite (el `INSERT ... ON CONFLICT` y la ventana `COMPLETED` evitan el doble despacho). Es la pregunta abierta P1 de `15-preguntas-abiertas.md`.
