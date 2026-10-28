# 08 — Observabilidad

> **Qué está implementado y qué no.** Las métricas y los logs de este documento **se emiten** desde el núcleo a través de los puertos `Logger` y `Metrics` (`src/common/telemetry.ts`) y se verifican en los tests con sus versiones en memoria. CloudWatch, el formato EMF, X-Ray, las alarmas y el dashboard son **diseño objetivo**: no se implementaron ni se desplegaron.

## Diseño

El núcleo no conoce CloudWatch. Emite eventos de negocio a dos puertos:

- `Logger.log(level, message, fields)`: una línea JSON por evento.
- `Metrics.count(name, dimensions, value)` y `Metrics.record(name, value, dimensions)`.

En producción, un adaptador implementaría esos puertos con **Powertools for AWS Lambda**: Logger (JSON con contexto de la invocación), Metrics (formato EMF: las métricas viajan dentro de los logs y CloudWatch las extrae, sin llamadas a `PutMetricData`) y Tracer (X-Ray). El cambio queda en `src/adapters/aws/`; el núcleo no se toca.

**Por qué EMF:** un Worker que emite 3 o 4 métricas por job, 30M de veces por mes, haría 100M+ de llamadas a `PutMetricData`. Con EMF el costo es el del log que ya se escribe.

## Métricas (namespace `Scheduler`)

| Métrica              | Tipo  | Dimensiones          | Quién la emite  | Qué indica                                                    |
| -------------------- | ----- | -------------------- | --------------- | ------------------------------------------------------------- |
| `JobsDispatched`     | count | `reason`             | Dispatcher      | Jobs encolados por tick (`DISPATCH` o `LOOKBACK`)             |
| `DispatchFailures`   | count | —                    | Dispatcher      | Envíos o ventanas que fallaron; la ventana queda `PROCESSING` |
| `JobsSucceeded`      | count | —                    | Worker          | Jobs terminados bien                                          |
| `JobsFailed`         | count | `reason`             | Worker, Requeue | `NON_RETRYABLE`, `EXHAUSTED`, `EXPIRED`, `INVALID_MESSAGE`    |
| `JobsDeferred`       | count | `provider`           | Worker          | Jobs deferidos por el breaker abierto                         |
| `RetryScheduled`     | count | `provider`           | Worker          | Reintentos agendados                                          |
| `CircuitStateChange` | count | `provider, from, to` | Worker          | Cada transición del breaker                                   |
| `CredentialErrors`   | count | `provider`           | Worker          | Respuestas 401/403                                            |
| `DownstreamLatency`  | valor | `provider`           | Worker          | Duración de la llamada a la API interna (ms)                  |
| `JobsRequeued`       | count | `reason`             | Requeue         | Mensajes devueltos de `retry` a la FIFO                       |
| `ReconcileFailures`  | count | —                    | Reconciler      | Re-encolados que no se pudieron enviar                        |
| `EnqueuedStale`      | count | `runDate`            | Reconciler      | Jobs `ENQUEUED` hace más de 3 h (backlog o envío perdido)     |
| `DailyCompletionPct` | valor | `runDate`            | Reconciler      | Terminales / ejecuciones creadas del día                      |
| `ExecutionsByStatus` | valor | `runDate, status`    | Reconciler      | Conteo por estado                                             |
| `PendingByProvider`  | valor | `runDate, provider`  | Reconciler      | Backlog (no terminales) por proveedor, solo si es mayor a 0   |

**Cardinalidad:** CloudWatch cobra cada combinación única de dimensiones como una métrica aparte. Con 2.000 proveedores, `DownstreamLatency{provider}`, `RetryScheduled{provider}` y `JobsDeferred{provider}` podrían llegar a miles de métricas personalizadas, con un costo mensual que supera al de todo el cómputo (`10-capacidad-y-costos.md`). Recomendación para el adaptador de producción: publicar esas tres **sin** la dimensión `provider` como métrica y dejar el desglose por proveedor en los logs, consultable con CloudWatch Logs Insights. `CircuitStateChange` y `CredentialErrors` sí conservan `provider`: son raras y son las que disparan alarmas. `PendingByProvider` solo se emite para proveedores con backlog.

## Alarmas (diseño objetivo)

| Alarma                               | Condición                                                             | Por qué                                                                    | Runbook               |
| ------------------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------- |
| DLQ FIFO con mensajes                | `ApproximateNumberOfMessagesVisible > 0`                              | Cada mensaje es un job que no terminó bien o un mensaje inválido           | `14-runbook.md` § DLQ |
| DLQ de `retry` con mensajes          | `ApproximateNumberOfMessagesVisible > 0`                              | Un reintento que no volvió a la FIFO: la fila queda `RETRYING` sin mensaje | § DLQ de retry        |
| FIFO atrasada                        | `ApproximateAgeOfOldestMessage > 30 min`                              | Backlog: un proveedor caliente o Workers que no consumen                   | § FIFO atrasada       |
| Completado por debajo de lo esperado | `DailyCompletionPct` < umbral por hora                                | El día no avanza; la métrica se emite cada hora                            | § Completado bajo     |
| Fallas del Dispatcher                | `DispatchFailures > 0`                                                | Una ventana quedó `PROCESSING`                                             | § Dispatcher          |
| Ventana estancada                    | Una fila `dispatch_windows` en `PROCESSING` con `started_at` > 10 min | El lookback no la pudo recuperar                                           | § Dispatcher          |
| Breaker abierto mucho tiempo         | Un proveedor en `OPEN` o `HALF_OPEN` por más de 30 min                | Un proveedor caído: sus jobs se defieren y pueden vencer                   | § Breaker             |
| Credenciales                         | `CredentialErrors > 0`                                                | 401/403: probablemente un secreto vencido; no se arregla reintentando      | § Credenciales        |
| Fallas del Reconciler                | `ReconcileFailures > 0` o la Lambda falla                             | La red de seguridad no está funcionando                                    | § Reconciler          |
| Errores de las Lambdas               | `Errors` de cada función > 0 (y `Throttles` > 0)                      | Una excepción no esperada; en el Worker implica re-entregas                | § Errores de Lambda   |
| Partición faltante                   | No existe la partición del mes siguiente                              | Los `INSERT` fallarían al cambiar de mes                                   | § Particiones         |

Las dos alarmas basadas en la base (ventana estancada, breaker abierto) necesitan una consulta periódica: el Reconciler puede publicar ambas como métricas en su corrida horaria, o una Lambda chica cada 5 minutos si se quiere detectar antes. Queda como decisión de implementación.

**Umbral de `DailyCompletionPct`:** como solo cuenta las ejecuciones ya creadas, en un día normal debería estar cerca del 100% en todo momento, menos el backlog en curso. Un umbral inicial razonable es 95% (a calibrar con datos reales); un proveedor caliente lo baja de forma sostenida y es justamente lo que se quiere ver.

## Dashboard (diseño objetivo)

Un dashboard de CloudWatch, definido en la IaC, con cuatro filas:

1. **Flujo del día:** `JobsDispatched`, `JobsSucceeded`, `JobsFailed` por `reason`, `DailyCompletionPct`.
2. **Colas:** mensajes visibles, en vuelo y edad del más viejo, para la FIFO, `retry` y las dos DLQ.
3. **Proveedores:** `CircuitStateChange`, `JobsDeferred`, los 10 proveedores con más `PendingByProvider` y la latencia p50/p99 de la API interna.
4. **Plataforma:** errores, throttles, duración y concurrencia de las 4 Lambdas; CPU, conexiones y latencia de commit de Aurora; conexiones del RDS Proxy.

## Formato de logs

Una línea JSON por evento. Las líneas de un job llevan su contexto, para poder seguirlo de punta a punta con una sola consulta:

```json
{
  "jobId": "123#2026-03-01",
  "providerId": "provider-00042",
  "runDate": "2026-03-01",
  "attempt": 2,
  "seq": 3,
  "reason": "RETRY",
  "errorType": "HTTP_503",
  "delayS": 17,
  "timestamp": "2026-03-01T14:07:12.345Z",
  "level": "info",
  "service": "daily-scheduler",
  "message": "retry scheduled"
}
```

Mensajes que emite el núcleo:

| Nivel   | Mensajes                                                                                                                                                                                                                                                                                                             |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `info`  | `dispatch window completed`, `job succeeded`, `retry scheduled`, `job deferred by open circuit`, `claim found nothing to do`, `defer found nothing to do`, `stale job requeued`, `missing job enqueued`, `reconcile completed`, `daily execution stats`, `circuit state change`                                      |
| `warn`  | `internal API call failed`, `job failed`, `claim lost before writing the result`, `circuit update lost every race`, `jobs ENQUEUED for too long`, `reconcile requeue limit reached`, `circuit state change` (al abrir)                                                                                               |
| `error` | `dispatch window failed`, `dispatch window left in PROCESSING`, `dispatch send failed`, `reconcile stale send failed`, `reconcile missing send failed`, `invalid message sent to DLQ`, `invalid retry message sent to DLQ`, `requeue failed`, `credential error from internal API`, `job failed, status not updated` |

Consultas útiles (CloudWatch Logs Insights):

```
# Todo lo que le pasó a un job
fields @timestamp, level, message, attempt, seq, errorType
| filter jobId = "123#2026-03-01"
| sort @timestamp asc

# Proveedores con más reintentos en la última hora
filter message = "retry scheduled"
| stats count(*) as retries by providerId
| sort retries desc
| limit 20
```

## Tracing (diseño objetivo)

X-Ray con Powertools Tracer en las 4 Lambdas, con anotaciones `jobId` y `providerId`. El salto por SQS corta la traza; el `jobId` en cada log es lo que permite unir las invocaciones de un mismo job. En la implementación de referencia alcanza con propagar el `jobId` (CLAUDE.md §10).

**Retención de logs:** 30 días en CloudWatch Logs; lo que haga falta para auditoría ya está en `executions` y `results` por 13 meses.
