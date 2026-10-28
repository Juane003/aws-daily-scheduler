# CLAUDE.md — Distributed Daily Scheduler (desafío técnico tapi)

Este archivo es la especificación de trabajo del repo. Leelo completo antes de escribir código o documentación.
Las decisiones marcadas como **FIJAS** no se cambian sin crear antes un ADR en `docs/adr/` y avisar al usuario.

---

## 0. Alcance: implementación de referencia

Este repo es una **implementación de referencia** (un blueprint arquitectónico), **no un sistema listo para producción**. Su objetivo es respaldar la arquitectura y la documentación del desafío con código ejecutable y testeado que demuestre los algoritmos centrales. Todo debe poder correrse con `npm install && npm test`, **sin cuenta de AWS y sin Docker**.

**Qué incluye:**
- Los algoritmos centrales en TypeScript: slot, dispatch con lookback, Worker (deadline, breaker, claim, clasificación y ramas de resultado), circuit breaker, clasificador de errores, backoff, Requeue y Reconciler.
- Puertos (interfaces) para base de datos, colas, HTTP, almacenamiento de objetos y reloj.
- **Adaptadores en memoria** que reproducen la semántica que importa para el diseño:
  - FIFO con un mensaje en vuelo por `MessageGroupId`, deduplicación de 5 min, visibility timeout y redrive por `maxReceiveCount`;
  - cola standard con `DelaySeconds`;
  - repositorio con `UNIQUE(registry_id, run_date)` y updates condicionales atómicos.
- Un **reloj virtual** para simular días completos en segundos.
- Un simulador de la API interna configurable por proveedor (latencia y tasas de 5xx/4xx) que registra la concurrencia por proveedor.
- El DDL completo de PostgreSQL (migraciones) y las seeds.
- Toda la documentación de §11.

**Qué no incluye** (decirlo explícitamente en el README y en `01-contexto-y-supuestos.md`):
- Despliegue real en AWS ni pruebas contra servicios reales.
- Adaptadores AWS completos. Si se agregan, van en `src/adapters/aws/`, son finos y llevan el comentario `// Not verified against AWS`.
- Pruebas de carga reales: se reemplazan por una **simulación** en memoria con reloj virtual, presentada como tal y nunca como benchmark.
- Hardening de producción (seguridad, IaC completa, alarmas desplegadas): se **documenta** como diseño objetivo, no se implementa.

**Regla de honestidad:** el README, los docs y los comentarios de cabecera de cada handler dicen "reference implementation". Ningún documento afirma que algo fue desplegado, medido en AWS o probado en producción.

---

## 1. Problema

Una tabla con N registros (`id, proveedor, endpoint, body`). Cada registro es una consulta a una API interna.

- Ejecutar **una consulta diaria por registro**, automática y **distribuida a lo largo del día**.
- **Guardar el resultado** en una base de datos.
- **Manejar errores**: algunos se reintentan y otros no.
- **Evitar concurrencia a un mismo proveedor.**
- Escala: 1M de filas hoy, con crecimiento a N veces. Diseñar para 10M y validarlo con la simulación (§9).
- Todo en AWS, en una sola cuenta y región. La API interna ejecuta **2 Lambdas por llamada**.
- Criterios de evaluación: diagrama claro y documentado, justificación de decisiones, ciclo de vida de desarrollo y plan de desarrollo.

---

## 2. Decisiones arquitectónicas (FIJAS)

| # | Decisión | Motivo corto |
|---|----------|--------------|
| D1 | **Slot wheel de 1.440 minutos**: `slot = uint32(sha256(registryId)[0..4]) % 1440`, persistido en `registries.slot` | Distribución uniforme y estable, y un solo schedule para toda la plataforma |
| D2 | **EventBridge Scheduler cada 1 min → Dispatcher Lambda** | Evita sincronizar 1M+ schedules contra la base |
| D3 | **`dispatch_windows` + lookback de 5 slots** en el Dispatcher | Recuperación rápida de ticks perdidos o de un Dispatcher caído |
| D4 | **La ejecución se registra al despachar** (`INSERT ... ON CONFLICT DO NOTHING`, estado `ENQUEUED`) | Permite ver lo encolado y nunca procesado; las escrituras quedan repartidas en el día, sin pico a medianoche |
| D5 | **SQS FIFO principal**, `MessageGroupId = providerId` (o `providerId#shard` si `k > 1`), modo high-throughput | Exclusión mutua por proveedor sin locks distribuidos |
| D6 | **ESM con `BatchSize = 1`** y `MaximumConcurrency` configurable | Manejo de errores simple; protege a la API interna y a Aurora |
| D7 | **Reintentos fuera de la FIFO**: cola SQS **standard** `retry` con `DelaySeconds` por mensaje (backoff exponencial con full jitter, máx. 900 s) → **Requeue Lambda** → FIFO | No bloquea el grupo del proveedor, permite delays de hasta 15 min y la FIFO no admite delay por mensaje |
| D8 | **Circuit breaker por proveedor** (tabla `provider_circuits` en Aurora) | Con D7 el grupo se desbloquea; sin breaker, los jobs siguientes seguirían golpeando a un proveedor caído |
| D9 | **DLQ FIFO**: no reintentables, intentos agotados, vencidos (`EXPIRED`) y poison messages (redrive con `maxReceiveCount = 3`). La cola `retry` tiene su propia **DLQ standard** | Cuarentena observable con camino de redrive |
| D10 | **Reconciler cada 1 hora**: re-encola `IN_PROGRESS` stale y slots vencidos sin ejecución del día | Red de seguridad dentro del mismo día, no al día siguiente |
| D11 | **Aurora PostgreSQL + RDS Proxy**; `executions` y `results` **particionadas por `run_date`**; payloads > 256 KB a S3 | Fuente de verdad relacional; unos 365M de filas por año exigen particiones y retención |
| D12 | **Idempotencia**: `jobId = registryId#runDate` (determinístico), `UNIQUE(registry_id, run_date)`, claim condicional en el Worker y header `Idempotency-Key` hacia la API interna | Entrega at-least-once sin efectos duplicados (sujeto a que la API respete el header) |

---

## 3. Flujo end-to-end

```
EventBridge (1 min) → Dispatcher → [Aurora: registries WHERE slot = s; INSERT executions ENQUEUED; dispatch_windows]
                                 → SQS FIFO (GroupId = provider)
SQS FIFO → ESM (BatchSize = 1) → Worker
   Worker: breaker OPEN?          → defer a retry (sin consumir intento) → ACK
           claim falla?            → ACK (duplicado o ya terminado)
           llamada a la API interna:
              2xx                  → results + SUCCEEDED + breaker.success → ACK
              reintentable         → breaker.failure; attempt < max ? retry(delay) : DLQ → ACK
              no reintentable      → FAILED_NON_RETRYABLE + DLQ → ACK
retry (standard, DelaySeconds) → Requeue Lambda → SQS FIFO (seq++)
EventBridge (1 h) → Reconciler → re-encola stale o faltantes del día
```

**Regla crítica del Worker:** antes de hacer ACK (devolver OK al ESM), el mensaje ya tiene que estar enviado a `retry` o a la DLQ. Si ese envío falla, **lanzar la excepción** para que la FIFO lo redelivere.

---

## 4. Modelo de datos (Aurora PostgreSQL 16)

Migraciones SQL en `database/migrations/` (numeradas, idempotentes).

```sql
-- registries: la tabla del enunciado + slot
registries(
  id BIGINT PK, provider_id TEXT NOT NULL, endpoint TEXT NOT NULL,
  http_method TEXT NOT NULL DEFAULT 'POST', body JSONB NOT NULL,
  slot SMALLINT NOT NULL CHECK (slot BETWEEN 0 AND 1439),
  enabled BOOLEAN NOT NULL DEFAULT true, created_at, updated_at)
INDEX (slot) INCLUDE (id, provider_id) WHERE enabled

-- execution_status: ENQUEUED | IN_PROGRESS | RETRYING | SUCCEEDED
--                   | FAILED_NON_RETRYABLE | FAILED_EXHAUSTED | FAILED_EXPIRED
executions(                                   -- PARTITION BY RANGE (run_date), una partición por mes
  registry_id BIGINT, run_date DATE, provider_id TEXT,
  status execution_status, attempt SMALLINT DEFAULT 0, seq SMALLINT DEFAULT 0,
  enqueued_at, started_at, finished_at, next_attempt_at,
  last_http_status SMALLINT, last_error_type TEXT, last_error TEXT,
  PRIMARY KEY (registry_id, run_date))
INDEX (run_date, status)  INDEX (provider_id, run_date)

results(                                      -- PARTITION BY RANGE (run_date)
  registry_id, run_date, http_status, duration_ms,
  response JSONB NULL, response_s3_key TEXT NULL, created_at,
  PRIMARY KEY (registry_id, run_date))

dispatch_windows(run_date DATE, slot SMALLINT, status TEXT /* PROCESSING | COMPLETED */,
  jobs_dispatched INT, started_at, completed_at, PRIMARY KEY (run_date, slot))

provider_circuits(provider_id TEXT PK, state TEXT /* CLOSED | OPEN | HALF_OPEN */,
  consecutive_failures INT DEFAULT 0, cooldown_seconds INT, open_until TIMESTAMPTZ,
  half_open_owner TEXT NULL, updated_at)
```

- **Retención:** configurable (default 13 meses). Las particiones viejas se eliminan con `DROP PARTITION`, nunca con `DELETE`.
- **Día de negocio:** `BUSINESS_TZ` (default `UTC`). Es una pregunta abierta para el usuario; no asumir otro valor.

---

## 5. Contrato de mensajes

```ts
interface JobMessage {
  jobId: string;          // `${registryId}#${runDate}`
  registryId: string;
  providerId: string;
  runDate: string;        // YYYY-MM-DD en BUSINESS_TZ
  attempt: number;        // llamadas reales ya hechas a la API (las deferidas por el breaker NO cuentan)
  seq: number;            // cantidad de re-encolados (incluye deferidos); se usa en el dedup id
  firstEnqueuedAt: string;
  reason?: 'DISPATCH' | 'RETRY' | 'CIRCUIT_DEFER' | 'RECONCILE' | 'LOOKBACK';
}
// FIFO: MessageGroupId = groupId(providerId, registryId), MessageDeduplicationId = `${jobId}#${seq}`
```

Validar con `zod` en cada consumer. Un mensaje inválido va a la DLQ con `reason = 'INVALID_MESSAGE'`; nunca se descarta en silencio.

---

## 6. Algoritmos

### 6.1 Dispatcher (por tick)
1. `slot = minuteOfDay(now, BUSINESS_TZ)`.
2. **Lookback:** para `s` desde `slot-5` hasta `slot-1` (cruzando medianoche y ajustando `runDate`), si `dispatch_windows(runDate, s)` no existe o no está `COMPLETED`, procesar ese slot igual que el actual.
3. `INSERT dispatch_windows ... ON CONFLICT DO UPDATE SET status = 'PROCESSING'`.
4. Paginar `registries WHERE slot = s AND enabled` por keyset sobre `id`, en páginas de 1.000.
5. Por página: `INSERT executions (..., 'ENQUEUED') ON CONFLICT DO NOTHING RETURNING registry_id` y encolar **solo los insertados** (los existentes ya fueron despachados). Enviar con `SendMessageBatch` en chunks de 10 y en paralelo acotado (p-limit, 10).
6. Reintentar las entradas fallidas del batch hasta 3 veces. Si aún fallan, dejar la ventana en `PROCESSING` (el lookback la retoma) y emitir la métrica `DispatchFailures`.
7. Marcar la ventana `COMPLETED` con `jobs_dispatched`.

### 6.2 Worker
1. Parsear y validar el mensaje.
2. **Deadline:** si `now > endOf(runDate) + EXPIRY_GRACE` (default 6 h), marcar `FAILED_EXPIRED`, enviar a la DLQ y hacer ACK.
3. **Breaker** (`circuit.allow(providerId)`):
   - `OPEN` con `now < open_until`: enviar a `retry` con `delay = min(900, open_until - now + jitter(0..30 s))`, `seq + 1`, `reason = CIRCUIT_DEFER`, **sin incrementar `attempt`**. Marcar `RETRYING` con `next_attempt_at` y hacer ACK.
   - `OPEN` con `now >= open_until`: intentar la transición atómica a `HALF_OPEN` (`UPDATE ... WHERE state = 'OPEN' AND open_until <= now RETURNING`). Si se gana, este Worker hace la **llamada de prueba**; si no, se defiere como en el caso anterior.
   - `HALF_OPEN` con otro dueño: deferir.
4. **Claim:** `UPDATE executions SET status = 'IN_PROGRESS', started_at = now() WHERE pk AND (status IN ('ENQUEUED', 'RETRYING') OR (status = 'IN_PROGRESS' AND started_at < now() - STALE_AFTER)) RETURNING attempt`. Si no actualiza filas, hacer ACK (es un duplicado o el job ya terminó).
5. Cargar el registro y llamar a la API interna con timeout `HTTP_TIMEOUT_MS` y los headers `Idempotency-Key: jobId` y `X-Provider-Id`.
6. Clasificar el resultado (6.4) y actuar:
   - **Éxito:** escribir `results` (S3 si el payload supera 256 KB), `SUCCEEDED`, `circuit.recordSuccess`.
   - **Reintentable:** `circuit.recordFailure`. Si `attempt + 1 >= MAX_ATTEMPTS` (default 8): `FAILED_EXHAUSTED` y DLQ. Si no: `RETRYING`, y enviar a `retry` con `delay = backoff(attempt + 1)`, respetando `Retry-After` si viene (con tope de 900).
   - **No reintentable:** `FAILED_NON_RETRYABLE` y DLQ. **No** cuenta para el breaker.
7. Todas las transiciones de estado son `UPDATE` condicionados al estado esperado.

### 6.3 Circuit breaker (`src/common/circuit-breaker.ts`)
- **Parámetros:** `CB_FAILURE_THRESHOLD = 5` fallas reintentables consecutivas; `CB_BASE_COOLDOWN = 60 s`; `CB_MAX_COOLDOWN = 900 s`.
- **CLOSED:** una falla incrementa `consecutive_failures` de forma atómica; al llegar al umbral pasa a `OPEN` con `open_until = now + cooldown`. Un éxito pone `consecutive_failures = 0`.
- **HALF_OPEN:** si la prueba sale bien, pasa a `CLOSED` y `cooldown = base`. Si falla, pasa a `OPEN` con `cooldown = min(2 × cooldown, max)`.
- Un dueño de `HALF_OPEN` que no reporta dentro de `STALE_AFTER` se considera perdido, y la fila vuelve a `OPEN` vencida.
- Un proveedor sin fila se considera `CLOSED` y la fila se crea con upsert.
- Emitir la métrica `CircuitStateChange{provider, from, to}` y loguear cada transición.
- **Interfaz pura más adaptador:** la lógica de transición es una función pura `transition(state, event, now, config)`, testeable sin base de datos.

### 6.4 Clasificación de errores (`src/common/error-classifier.ts`)
| Caso | Clase |
|------|-------|
| 2xx | SUCCESS |
| 408, 425, 429, 500, 502, 503, 504 | RETRYABLE (429 y 503 respetan `Retry-After`) |
| Throttling de Lambda / API Gateway de la API interna | RETRYABLE |
| Errores de red: **usar `error.code`** (`ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`, `EAI_AGAIN`, `EPIPE`, `UND_ERR_*`) y **`error.name`** `AbortError` / `TimeoutError` | RETRYABLE |
| Resto de 4xx (400, 401, 403, 404, 409, 422, ...) | NON_RETRYABLE (401 y 403, además, disparan alarma de credenciales) |
| Error desconocido | RETRYABLE, contando para `MAX_ATTEMPTS`. Ante la duda se reintenta acotado: es mejor que perder el job |

**Backoff:** `min(900, base × 2^(n-1))` con full jitter (`random(0, valor)`), con `base = 10 s`.

### 6.5 Requeue Lambda
Consume `retry` (standard, batch de 10, `ReportBatchItemFailures`), valida el mensaje y hace `SendMessage` a la FIFO con `MessageDeduplicationId = jobId#seq`. No toca la base de datos (el estado ya es `RETRYING`).

### 6.6 Reconciler (cada hora)
1. **Stale:** `executions` en `IN_PROGRESS` con `started_at < now - STALE_AFTER` (default `2 × visibility timeout`). Pasarlas a `RETRYING` y re-encolarlas con `seq + 1`, sin sumar intento: el intento ya se contó al hacer el claim.
2. **Faltantes:** para los slots del día con `slot < slotActual - 10`, buscar `registries` sin fila en `executions`. Insertarlos como `ENQUEUED` y encolarlos con `reason = RECONCILE`.
3. **`ENQUEUED` viejos:** con `enqueued_at < now - ENQUEUED_STALE` (default 3 h), **solo reportar** en logs y métricas, sin re-encolar. La espera puede ser legítima por backlog del proveedor; la FIFO y el claim cubren duplicados si se re-encolaran.
4. Publicar `% completados del día`, conteos por estado y por proveedor.
5. Procesar en páginas y con un límite de re-encolados por corrida (`RECONCILE_MAX_REQUEUE`), para no inundar la FIFO.

---

## 7. Configuración (variables de entorno con defaults)
`BUSINESS_TZ=UTC`, `LOOKBACK_SLOTS=5`, `PROVIDER_SHARDS_K=1` (mapa por proveedor opcional en SSM), `HTTP_TIMEOUT_MS=10000`, `WORKER_TIMEOUT_S=30`, visibility de la FIFO = `6 × WORKER_TIMEOUT_S`, `MAX_ATTEMPTS=8`, `RETRY_BASE_S=10`, `CB_FAILURE_THRESHOLD=5`, `CB_BASE_COOLDOWN_S=60`, `CB_MAX_COOLDOWN_S=900`, `STALE_AFTER_S=360`, `EXPIRY_GRACE_H=6`, `ESM_MAX_CONCURRENCY=200`, `RESULT_INLINE_MAX_BYTES=262144`.

**Restricción de timeouts:** `HTTP_TIMEOUT < WORKER_TIMEOUT < visibility timeout`. Validarla al iniciar y en un test.

---

## 8. Stack y convenciones
- **Lenguaje:** TypeScript en modo `strict`, Node.js 20, ESM.
- **Librerías:** `zod` y Powertools for AWS Lambda (Logger y Metrics, que funcionan localmente). AWS SDK v3 y `pg` solo si se agregan los adaptadores AWS opcionales.
- **IaC (opcional):** un **esqueleto** de AWS CDK v2 en `infra/` que muestra los recursos y su configuración clave (FIFO, ESM con `BatchSize = 1`, retry con su DLQ, Schedulers y alarmas) y que solo debe sintetizar. No se despliega. El diseño completo de los stacks se documenta en `02-arquitectura.md` y `12-ciclo-de-vida-de-desarrollo.md`.
- **Arquitectura hexagonal liviana:** los handlers son finos, la lógica vive en `src/core/*` con puertos (interfaces), los adaptadores en memoria están en `src/adapters/memory/*` (obligatorios, se usan en los tests) y los adaptadores AWS en `src/adapters/aws/*` (opcionales).
- **Código:** el código, los identificadores y los comentarios van en **inglés**. La **documentación** en `docs/` va en **español**.
- **Logs:** JSON con `jobId`, `providerId`, `runDate`, `attempt`, `seq` y `reason` en cada línea relevante.
- **Configuración:** sin secretos en código. Las credenciales de la base van por IAM auth a RDS Proxy o Secrets Manager.
- **Lint y formato:** ESLint y Prettier. Commits con Conventional Commits.

### Estructura del repo
```
src/
  handlers/{dispatcher,worker,requeue,reconciler}.ts
  core/{dispatch,execute,reconcile}/...
  common/{slot,error-classifier,backoff,circuit-breaker,config,message,time}.ts
  adapters/memory/{fifo-queue,standard-queue,repository,object-store,clock}.ts
  adapters/aws/...      (opcional, "Not verified against AWS")
  simulation/{api-simulator,harness}.ts
database/migrations/  database/seeds/
infra/                 (esqueleto CDK, opcional)
tests/unit/ tests/integration/ tests/simulation/
docs/                  (ver §11)  docs/adr/  docs/diagrams/
scripts/               (generador de seeds, ejemplo de redrive de DLQ)
```

### Comandos
- `npm run build`, `npm run lint`, `npm test`, `npm run test:unit`, `npm run test:integration`
- `npm run simulate -- --rows 1000000 --providers 2000 --hot-provider 0.2` (simulación con reloj virtual)
- `npm run cdk:synth` (solo si existe el esqueleto de `infra/`)

Antes de dar una tarea por terminada, correr `build`, `lint` y `test`, y que pasen. Reportar los resultados reales, nunca inventados.

---

## 9. Tests obligatorios
- **Slot:** es determinístico, está en el rango 0..1439 y es uniforme (chi-cuadrado sobre 1M de ids, con p > 0.01).
- **Clasificador:** cubre cada fila de la tabla 6.4, incluidos `error.code` vs `error.name`, `AbortError`, `TimeoutError`, 408 y `Retry-After`.
- **Backoff:** respeta el tope de 900 y el rango del jitter.
- **Breaker:** tabla de transiciones completa; carrera por `HALF_OPEN` (solo uno gana); el cooldown se duplica y respeta el máximo; los 4xx no cuentan.
- **Dispatcher:**
  - lookback cruzando medianoche;
  - un registro ya despachado no se re-encola;
  - un fallo parcial del batch deja la ventana en `PROCESSING`.
- **Worker** (con dobles de los puertos):
  - éxito;
  - reintentable antes y después de `MAX_ATTEMPTS`;
  - no reintentable;
  - breaker `OPEN`: defiere sin sumar intento;
  - llamada de prueba en `HALF_OPEN`;
  - claim duplicado: ACK sin llamar a la API;
  - fallo al enviar a `retry`: lanza la excepción;
  - job `EXPIRED`.
- **Reconciler:** detecta stale y faltantes, respeta el límite por corrida y no re-encola los terminales.
- **Adaptadores en memoria:** tienen sus propios tests, porque el resto de las pruebas depende de que imiten bien a AWS: un solo mensaje en vuelo por grupo, deduplicación dentro de la ventana, reentrega al vencer la visibility, redrive al superar `maxReceiveCount` y `DelaySeconds`.
- **Integración** (en memoria, con reloj virtual, sin Docker): el flujo completo Dispatcher → FIFO → Worker → simulador de API → Retry/Requeue → DLQ → Reconciler, verificando que:
  - **nunca hay 2 llamadas simultáneas al mismo proveedor** (el simulador registra la concurrencia por proveedor y el test lo afirma);
  - el breaker abre ante un proveedor con 100% de 503 y no le llegan llamadas durante el cooldown;
  - un crash simulado del Worker antes y después de la llamada no pierde ni duplica jobs;
  - todos los jobs terminan en un estado terminal.
- **Simulación de escala** (`tests/simulation/` y `npm run simulate`): 1M de registros (10M si la memoria lo permite) con reloj virtual; un caso con un proveedor caliente. Reportar la distribución por minuto, el tiempo de vaciado por proveedor y que el proveedor caliente supera el techo `86.400 / latencia`. Presentarlo siempre como **simulación**, no como benchmark de AWS.
- **Opcional:** `npm run test:db` con Testcontainers para validar las migraciones contra un Postgres real, solo si hay Docker. No forma parte de `npm test`.
- **Cobertura mínima:** 90% de líneas en `src/core` y `src/common`.

---

## 10. Observabilidad y seguridad
En la implementación de referencia, las métricas y los logs se emiten con Powertools y se verifican en los tests. Las alarmas, el dashboard, el tracing y la seguridad son el **diseño objetivo**: se documentan (y, si existe, se esbozan en el esqueleto de CDK), pero no se despliegan.

- **Métricas** (namespace `Scheduler`):
  - `JobsDispatched`, `DispatchFailures`, `JobsSucceeded`, `JobsFailed{reason}`, `JobsDeferred{provider}`;
  - `RetryScheduled`, `CircuitStateChange`, `DownstreamLatency{provider}`, `DailyCompletionPct`.
- **Alarmas:**
  - cualquier DLQ con más de 0 mensajes;
  - `ApproximateAgeOfOldestMessage` de la FIFO por encima de 30 min;
  - `DailyCompletionPct` por debajo de lo esperado para la hora;
  - `DispatchFailures` mayor a 0;
  - una ventana `PROCESSING` con más de 10 min;
  - un breaker `OPEN` por más de 30 min;
  - errores 401/403.
- **Tracing:** X-Ray mediante Powertools Tracer.
- **Dashboard:** definido en CDK.
- **Seguridad:**
  - Lambdas en subnets privadas multi-AZ, con VPC endpoints (SQS, S3, Secrets Manager, execute-api);
  - security groups encadenados (Lambda → Proxy → Aurora);
  - un rol IAM por Lambda con mínimo privilegio;
  - KMS en las colas, Aurora y S3;
  - API interna privada.

---

## 11. Documentos a generar (`docs/`, en español)
Cada documento incluye el **porqué** de cada decisión y sus trade-offs; no se limita a describir. Los diagramas van en Mermaid dentro del `.md`. El diagrama principal está en `docs/diagrams/arquitectura.excalidraw` y debe mantenerse sincronizado: si cambia la arquitectura, se actualizan ambos.

1. `00-indice.md`: mapa de la documentación y un resumen ejecutivo de una página.
2. `01-contexto-y-supuestos.md`: el enunciado, los supuestos explícitos y lo que queda fuera de alcance.
3. `02-arquitectura.md`: el diagrama, una tabla de componentes con su responsabilidad y la secuencia end-to-end.
4. `03-distribucion-diaria.md`: el slot wheel, la cuenta de jobs por minuto (1M y 10M), el lookback y el día de negocio.
5. `04-concurrencia-por-proveedor.md`: la FIFO y los grupos, `BatchSize = 1`, el techo `86.400 / latencia` y el sharding `k`.
6. `05-errores-reintentos-circuit-breaker.md`: la clasificación, el backoff, la cola `retry`, el breaker (con diagrama de estados) y por qué se eligió esta opción frente a reintentar en la misma FIFO.
7. `06-idempotencia-y-consistencia.md`: el `jobId`, el claim, las capas de deduplicación y los escenarios de falla paso a paso (crash antes o después de la llamada, envío fallido, tick duplicado).
8. `07-modelo-de-datos.md`: el DDL, los índices, las particiones, la retención y S3.
9. `08-observabilidad.md`: métricas, alarmas, dashboard y formato de logs.
10. `09-seguridad.md`: red, IAM, cifrado y secretos.
11. `10-capacidad-y-costos.md`: el dimensionamiento y una estimación mensual de costos para 1M y 10M, **marcada como estimación** y con los precios de referencia citados y fechados.
12. `11-alternativas-descartadas.md`: un schedule por job, `SKIP LOCKED`, Redis o DynamoDB como lock, Step Functions, Kinesis, una cola por proveedor, reintentos en la misma FIFO y tabla diaria materializada a medianoche.
13. `12-ciclo-de-vida-de-desarrollo.md`: branching, CI/CD (GitHub Actions con build, lint, test, `cdk synth` y escaneo de secretos), ambientes dev/staging/prod, canary con aliases de Lambda y CodeDeploy, y rollback.
14. `13-plan-de-desarrollo.md`: fases como vertical slices, cada una con su entregable y su Definition of Done (ver §12).
15. `14-runbook.md`: qué hacer ante cada alarma, cómo hacer el redrive de las DLQ, cómo cerrar un breaker manualmente y cómo re-despachar un día.
16. `15-preguntas-abiertas.md`: el día de negocio, la distribución de registros por proveedor, si la API respeta el `Idempotency-Key`, la concurrencia permitida por proveedor, los SLA y la retención.
17. `adr/ADR-NNN-*.md`: un ADR por cada decisión D1 a D12, con contexto, decisión, alternativas y consecuencias.

---

## 12. Plan de ejecución (seguir este orden)
Cada fase termina con `build`, `lint` y `test` en verde, los documentos de esa fase actualizados y un commit.

1. **Esqueleto:** repo, tooling, CI (build, lint y test), config validada, migraciones y seeds.
2. **Núcleo puro:** slot, clasificador, backoff, transiciones del breaker y contrato de mensajes, más sus tests unitarios.
3. **Adaptadores en memoria y reloj virtual**, con sus tests de semántica.
4. **Dispatcher:** dispatch y lookback, con tests.
5. **Worker:** claim, llamada a la API y ramas de resultado, con el breaker integrado, y tests.
6. **Requeue y Reconciler**, con tests.
7. **Integración en memoria:** el simulador de API y la afirmación de concurrencia por proveedor.
8. **Simulación de escala:** `npm run simulate`, el caso de proveedor caliente y la documentación de resultados como simulación.
9. **(Opcional) Esqueleto de CDK** que sintetiza y adaptadores AWS finos marcados como no verificados.
10. **Documentación final:** revisar los documentos 00 a 15 y los ADRs, sincronizar el diagrama y el README.

**Si el tiempo es limitado,** el orden de prioridad es: fases 1, 2, 5 y 7 (son las que prueban distribución, errores y concurrencia) y la documentación. La fase 9 es la primera que se recorta.

---

## 13. Reglas de trabajo para Claude
- Si una decisión no está cubierta acá, elegir la opción más simple, documentarla en `15-preguntas-abiertas.md` o en un ADR y seguir.
- No cambiar las decisiones D1 a D12 en silencio.
- No inventar números de AWS (límites, precios). Si no se verificaron, marcarlos como "a verificar" con la fuente sugerida.
- No usar `any` en TypeScript. No usar `console.log` suelto: se usa el Logger de Powertools.
- Cada rama de error del Worker necesita su test.
- Mantener el README con una descripción corta, una nota visible de que es una **implementación de referencia** (qué demuestra y qué queda fuera, según §0), el diagrama, cómo correr localmente y un índice a `docs/`.
- Ante una tarea que solo tendría sentido con AWS real (deploy, medir latencias o costos reales), no simularla como si fuera real: documentarla como diseño objetivo o como trabajo futuro.
