# 14 — Runbook

Qué hacer ante cada alarma y cómo ejecutar las operaciones manuales. Los comandos de AWS CLI y SQL son **diseño objetivo**: no se ejecutaron contra AWS. Las consultas usan el esquema de `database/migrations/`; la herramienta de redrive está en `scripts/redrive-dlq.ts`.

> **Regla general:** antes de re-encolar o modificar filas, entender por qué fallaron. Re-encolar sin arreglar la causa solo repite el error y consume capacidad del proveedor.

## Consultas de diagnóstico

```sql
-- Estado del día
SELECT status, count(*) FROM executions WHERE run_date = current_date GROUP BY status;

-- Backlog por proveedor (no terminales)
SELECT provider_id, count(*) AS pending
FROM executions
WHERE run_date = current_date AND status IN ('ENQUEUED', 'IN_PROGRESS', 'RETRYING')
GROUP BY provider_id ORDER BY pending DESC LIMIT 20;

-- Errores más frecuentes del día
SELECT provider_id, last_error_type, last_http_status, count(*)
FROM executions
WHERE run_date = current_date AND status LIKE 'FAILED_%'
GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 20;

-- Breakers que no están cerrados
SELECT * FROM provider_circuits WHERE state <> 'CLOSED' ORDER BY updated_at;

-- Ventanas del Dispatcher sin completar
SELECT * FROM dispatch_windows WHERE status = 'PROCESSING' ORDER BY started_at;
```

Para seguir un job: `jobId = <registry_id>#<run_date>` en CloudWatch Logs Insights (`08-observabilidad.md`).

## Alarmas

### DLQ FIFO con mensajes

1. Ver los motivos: los mensajes del Worker tienen `reason` (`NON_RETRYABLE`, `EXHAUSTED`, `EXPIRED`, `INVALID_MESSAGE`) y `error` (`last_error_type`). Los que llegan sin sobre (un `JobMessage` "pelado") son **poison messages**: el Worker falló 3 veces seguidas con una excepción. Para esos, buscar el `jobId` en los logs de error de la Lambda.
2. Agrupar por proveedor y tipo de error con la consulta de "errores más frecuentes".
3. Según la causa:
   - **`NON_RETRYABLE` con 4xx** (400, 404, 422): el registro está mal (endpoint o body). Corregir el registro con el dueño de los datos y hacer redrive. Un 401/403 se trata en "Credenciales".
   - **`EXHAUSTED`:** el proveedor falló 8 veces. Si el proveedor ya está sano, hacer redrive.
   - **`EXPIRED`:** el día de negocio terminó. **No** se re-ejecuta bajo la misma fecha (la herramienta de redrive los descarta). Si el negocio necesita el dato, decidirlo caso por caso.
   - **`INVALID_MESSAGE`:** un bug de un productor o un mensaje manual mal armado. Arreglar el productor; el body original está en `raw`.
   - **Poison:** un bug del Worker o de un adaptador. Arreglar, desplegar y hacer redrive.
4. Hacer el redrive (abajo) y verificar que la DLQ vuelve a 0.

### DLQ de `retry` con mensajes

La Requeue no pudo devolver esos mensajes a la FIFO; sus filas quedan en `RETRYING` sin mensaje y **nadie las va a retomar sola** (el Reconciler no busca `RETRYING`, ver `15-preguntas-abiertas.md`).

1. Buscar la causa en los logs de error de la Requeue (`requeue failed`): normalmente permisos o un problema de SQS.
2. Arreglarla y mover los mensajes de vuelta a `retry` con el redrive nativo de SQS:
   ```bash
   aws sqs start-message-move-task \
     --source-arn "$RETRY_DLQ_ARN" --destination-arn "$RETRY_QUEUE_ARN"
   ```
   (Disponible para colas standard; **a verificar** en la documentación de SQS.) La Requeue los vuelve a enviar a la FIFO con su `jobId#seq`.

### FIFO atrasada (`ApproximateAgeOfOldestMessage` > 30 min)

1. ¿Es un solo proveedor? Consultar el backlog por proveedor. Si uno concentra el backlog y su breaker está cerrado, es un **proveedor caliente** por encima de su techo (`04-concurrencia-por-proveedor.md`): no se arregla con más Workers. Escalar: sharding si el proveedor lo admite, o acordar menor frecuencia.
2. ¿Es general? Revisar la concurrencia del Worker (¿llegó a `MaximumConcurrency`?), los throttles de Lambda y la latencia de la API interna. Subir `MaximumConcurrency` solo si la API interna y Aurora tienen margen.
3. ¿El Worker está fallando? Ver "Errores de Lambda".

### `DailyCompletionPct` por debajo de lo esperado

Es un síntoma, no una causa: seguir la consulta "estado del día". Si dominan `ENQUEUED`, es backlog (ver "FIFO atrasada"); si dominan `RETRYING`, hay breakers abiertos o errores de un proveedor; si dominan `FAILED_*`, ver la DLQ.

### `DispatchFailures` > 0 o ventana `PROCESSING` por más de 10 min

1. El lookback reintenta las ventanas `PROCESSING` durante 5 minutos. Si la alarma de ventana estancada sigue, el problema persiste: ver los logs del Dispatcher (`dispatch window failed`, `dispatch send failed`).
2. Causas típicas: Aurora o el proxy no disponibles, throttling de SQS, permisos.
3. Una vez arreglado, las ventanas fuera del lookback se recuperan así:
   - los registros **sin** fila en `executions` los toma el Reconciler en su próxima corrida (hasta 10.000 por corrida);
   - los que quedaron `ENQUEUED` sin enviar aparecen en `EnqueuedStale` a las 3 h. Para no esperar, re-despachar la ventana (abajo).

### Breaker abierto por más de 30 min

1. Confirmar que el proveedor sigue fallando: logs `internal API call failed` y `circuit state change` para ese `providerId`. Un breaker que se reabre una y otra vez con cooldown de 900 s indica un proveedor caído.
2. Avisar al dueño del proveedor o de la API interna. Los jobs del proveedor se están difiriendo y van a vencer al terminar el día más la gracia de 6 h.
3. Cuando el proveedor se recupere, el breaker cierra solo con la próxima llamada de prueba (como mucho 15 minutos). Para no esperar, cerrarlo a mano (abajo).

### `CredentialErrors` > 0 (401/403)

1. Un 401/403 no se reintenta: cada job termina en la DLQ como `NON_RETRYABLE`.
2. Revisar el secreto o el permiso de IAM hacia la API interna (vencimiento, rotación fallida, policy cambiada).
3. Arreglado el acceso, hacer redrive de los `NON_RETRYABLE` con `HTTP_401`/`HTTP_403` del día.

### Errores de Lambda

- **Worker:** cada excepción deja el mensaje sin ACK y se re-entrega a los 180 s. Si la excepción ocurre **antes** del claim (por ejemplo, Aurora no disponible), se repite y tras 3 entregas el mensaje va a la DLQ como poison. Si ocurre **después** del claim, la re-entrega encuentra la fila `IN_PROGRESS`, hace ACK, y el job lo recupera el Reconciler cuando queda stale (`06-idempotencia-y-consistencia.md`). Ver el stack en los logs. Si la causa es un despliegue, el canary debería haber hecho rollback; si no, re-apuntar el alias a la versión anterior.
- **Dispatcher / Reconciler:** ver sus secciones. Ambos son idempotentes: re-invocarlos a mano es seguro.

### Partición faltante

Crear las particiones que falten y revisar por qué no corrió el job mensual:

```sql
SELECT ensure_monthly_partitions('executions', current_date, 2);
SELECT ensure_monthly_partitions('results', current_date, 2);
```

## Operaciones

### Redrive de la DLQ FIFO

La herramienta trabaja sobre los bodies exportados, no necesita credenciales de AWS y acepta los dos formatos de la DLQ (sobre del Worker y poison message):

```bash
# 1. Exportar los mensajes (un body por línea). Ejemplo con la CLI, en un loop hasta vaciar:
aws sqs receive-message --queue-url "$DLQ_URL" --max-number-of-messages 10 \
  --visibility-timeout 600 --query 'Messages[].Body' --output json | jq -c '.[]' >> dlq.jsonl

# 2. Generar el redrive
npm run redrive -- --in dlq.jsonl --out redrive/2026-03-01

# 3. Resetear las filas (RETRYING, attempt = 0, seq nuevo). Revisar el SQL antes de correrlo.
psql "$DATABASE_URL" -f redrive/2026-03-01.sql

# 4. Enviar cada batch a la FIFO
for f in redrive/2026-03-01-[0-9]*.json; do
  aws sqs send-message-batch --queue-url "$FIFO_URL" --entries "file://$f"
done

# 5. Borrar de la DLQ los mensajes procesados (con los receipt handles del paso 1)
```

- Los jobs `EXPIRED` y los mensajes ilegibles quedan en `redrive/2026-03-01-skipped.json` para revisión manual.
- El redrive da **intentos nuevos** (`attempt = 0`): se supone que la causa se arregló.
- Es seguro repetirlo: un job ya `SUCCEEDED` no se toca (`status <> 'SUCCEEDED'`), y si llegara un mensaje duplicado, el claim lo descarta.

### Cerrar un breaker manualmente

Solo si se confirmó que el proveedor está sano (por ejemplo, con una llamada manual):

```sql
UPDATE provider_circuits
SET state = 'CLOSED', consecutive_failures = 0, cooldown_seconds = 60,
    open_until = NULL, half_open_owner = NULL, updated_at = now()
WHERE provider_id = 'provider-00042';
```

Los jobs diferidos están en `retry` con delays de hasta 15 minutos: vuelven solos y esta vez encuentran el circuito cerrado. Si el proveedor sigue fallando, el breaker se vuelve a abrir tras 5 fallas: cerrarlo a mano no es peligroso, solo inútil.

Para **abrir** un breaker a mano (frenar un proveedor que pide parar), poner `state = 'OPEN'` y `open_until` en el instante hasta el que se quiere frenar; los jobs se difieren hasta entonces.

### Re-despachar una ventana o un día

**Una ventana con jobs `ENQUEUED` que no se enviaron** (fallo del Dispatcher fuera del lookback):

```sql
-- Volver a abrir la ventana: el Dispatcher solo la retoma si está dentro del lookback,
-- así que para ventanas viejas conviene el redrive de las filas ENQUEUED.
SELECT e.registry_id, e.run_date, e.provider_id
FROM executions e JOIN registries r ON r.id = e.registry_id
WHERE e.run_date = DATE '2026-03-01' AND r.slot = 420 AND e.status = 'ENQUEUED';
```

Con esa lista se arman los mensajes (`jobId#0`, `reason = RECONCILE`) igual que en el redrive: la FIFO descarta los que ya estuvieran encolados en los últimos 5 minutos y el claim descarta el resto.

**Un día entero que no se despachó** (Dispatcher caído durante horas): no hace falta tocar nada. El Reconciler encola cada hora los registros de slots vencidos sin ejecución, **hasta 10.000 por corrida** (`reconcileMaxRequeue`). Con 1M de registros sin despachar eso llevaría 100 horas: subir temporalmente el límite (por ejemplo, a 100.000) e invocar el Reconciler varias veces, vigilando la edad de la FIFO. Cada invocación es idempotente.

**Re-ejecutar un día ya ejecutado** (por ejemplo, porque la API devolvió datos incorrectos todo el día): requiere decisión de negocio. Las filas terminales del día se pasan a `RETRYING` con `attempt = 0` y se re-encolan como en el redrive; el resultado nuevo reemplaza al anterior (`results` es un upsert). No hay que borrar filas.
