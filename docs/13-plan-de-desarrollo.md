# 13 — Plan de desarrollo

El plan para llevar este diseño a producción, en **vertical slices**: cada fase termina en algo que corre de punta a punta en AWS y aporta valor por sí mismo, en lugar de construir capas horizontales (toda la base, después todas las colas, …) que solo sirven al final.

La implementación de referencia de este repo ya cubre la lógica de todas las fases, testeada en memoria. Lo que queda en cada fase es, sobre todo, infraestructura, adaptadores AWS y validación contra servicios reales.

## Fase 0 — Decisiones abiertas (antes de construir)

**Entregable:** respuestas a las preguntas de `15-preguntas-abiertas.md` que cambian el diseño: día de negocio, si la API respeta `Idempotency-Key`, concurrencia admitida por proveedor, distribución de registros por proveedor, latencia de la API, tamaño de las respuestas y SLA.

**Definition of Done:** cada respuesta registrada (y un ADR nuevo si alguna cambia una decisión D1–D12); proveedores que superan su techo diario identificados con los datos reales.

## Fase 1 — Esqueleto desplegable

**Entregable:** red (VPC, subnets privadas, endpoints), Aurora + RDS Proxy con las migraciones aplicadas, pipeline de CI/CD con despliegue a dev, y un Dispatcher que en cada tick solo registra la ventana (`dispatch_windows`) sin encolar.

**DoD:** `cdk deploy` a dev desde el pipeline; las migraciones corren en el deploy; las ventanas se completan minuto a minuto durante 24 h; alarma de errores de Lambda activa.

## Fase 2 — Un registro de punta a punta (camino feliz)

**Entregable:** FIFO, ESM y Worker con adaptadores AWS para SQS, Aurora y la API interna. Un proveedor de prueba con pocos registros reales se consulta una vez por día y el resultado queda en `results`.

**DoD:** 7 días seguidos con todos los jobs del proveedor de prueba en `SUCCEEDED`; logs con `jobId` consultables; tests de contrato de los adaptadores en verde contra dev.

## Fase 3 — Errores y protección de proveedores

**Entregable:** cola `retry`, Requeue, DLQ, circuit breaker y alarmas de DLQ y de breaker. Runbook de DLQ y de breaker ensayado.

**DoD:** con un proveedor simulado en dev que devuelve 503, el breaker abre y no recibe llamadas durante el cooldown (el mismo invariante que el test de integración, ahora en AWS); un 4xx termina en la DLQ; un redrive de la DLQ funciona siguiendo el runbook.

## Fase 4 — Red de seguridad

**Entregable:** lookback del Dispatcher (ya en fase 1–2), Reconciler horario, métricas `DailyCompletionPct` y `EnqueuedStale`, dashboard.

**DoD:** ensayos en staging: deshabilitar el schedule del Dispatcher 15 minutos y verificar que el lookback y el Reconciler recuperan todo el día; matar Workers a mitad de la llamada y verificar que ningún job se pierde.

## Fase 5 — Escala

**Entregable:** prueba de carga en staging con 1M de registros (y 10M si el presupuesto lo permite) contra una API interna simulada con la latencia real medida en la fase 0. Ajuste de `MaximumConcurrency`, tamaño de Aurora, memoria del Worker y alarmas.

**DoD:** un día completo a 1M con `DailyCompletionPct` ≥ el SLA acordado, sin mensajes en la DLQ que no correspondan a errores reales, y costos medidos comparados contra `10-capacidad-y-costos.md` (actualizar la estimación con los valores medidos).

## Fase 6 — Producción gradual

**Entregable:** despliegue a prod con canary; habilitación de registros por tandas (por ejemplo, 1%, 10%, 50% y 100% de los proveedores), usando `registries.enabled`.

**DoD:** cada tanda corre 3 días sin alarmas no explicadas antes de habilitar la siguiente; el runbook está validado por el equipo de guardia; el día del primer despliegue se tiene en cuenta que el lookback y el Reconciler encolan la cola del día anterior (`15-preguntas-abiertas.md`).

## Fase 7 — Operación y mejoras

Candidatas, según lo que muestren las métricas de producción:

- Sharding `k` por proveedor para los que lo admitan y superen su techo.
- Repartir los envíos del Dispatcher dentro del minuto si la ráfaga afecta a proveedores saturados (`04`).
- Paso del Reconciler para filas `RETRYING` huérfanas (`15-preguntas-abiertas.md`).
- Filtrar por `registries.created_at` en el Reconciler, para no crear jobs del día anterior a registros nuevos.

## Riesgos principales

| Riesgo                                                                                                | Mitigación                                                                                                 |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| La API interna no respeta `Idempotency-Key`                                                           | Fase 0. Si no lo hace, un crash después de la llamada puede duplicar una consulta: documentarlo y medirlo. |
| Proveedores por encima de su techo diario                                                             | Detectados en la fase 0 con los datos reales; sharding, más capacidad o menor frecuencia.                  |
| La API interna no soporta la concurrencia necesaria a 10M (~127 Workers, ~254 Lambdas suyas en curso) | Prueba de carga conjunta en la fase 5; `MaximumConcurrency` como freno.                                    |
| Costos de métricas por proveedor                                                                      | Desglose por proveedor en logs, no en métricas (`08`).                                                     |
