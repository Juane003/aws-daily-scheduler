# 10 — Capacidad y costos

> **Estimación, no medición.** Ningún número de este documento se midió en AWS. La capacidad sale de cuentas y de la simulación en memoria (`docs/simulacion/`); los costos, de precios públicos de `us-east-1` consultados el **2026-10-28** (fuentes al final) multiplicados por volúmenes **supuestos**. Los supuestos que más mueven el resultado están marcados y deben validarse con una prueba en un ambiente real antes de comprometer presupuesto.

## Supuestos

| Supuesto                   | Valor                                                 | Si cambia…                                                      |
| -------------------------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| Latencia de la API interna | 1 s por llamada (la simulación usa 0,6 s)             | Escala casi lineal el costo del Worker y el techo por proveedor |
| Memoria del Worker         | 256 MB, Arm (Graviton)                                | El costo del Worker es proporcional                             |
| Respuesta típica           | ~1 KB                                                 | Escala el almacenamiento de Aurora                              |
| Reintentos                 | ~3% de los jobs pasan por `retry`                     | Poco impacto salvo incidentes                                   |
| Logs                       | ~1,5 KB por job (incluye los de la plataforma Lambda) | Escala CloudWatch Logs                                          |
| Mes                        | 30 días · 730 horas                                   | —                                                               |

## Capacidad

| Magnitud                                         | 1M de registros | 10M de registros | Cómo se obtiene                                  |
| ------------------------------------------------ | --------------- | ---------------- | ------------------------------------------------ |
| Jobs por minuto (promedio / máximo)              | 694 / 787       | 6.944 / 7.226    | Calculado sobre el slot wheel (`03`)             |
| Jobs por segundo (promedio)                      | 11,6            | 116              | N / 86.400                                       |
| Workers en curso (promedio)                      | ~13             | ~127             | jobs/s × 1,1 s (Little)                          |
| Escrituras en Aurora por segundo (promedio)      | ~46             | ~460             | ~4 por job (`07`)                                |
| Llamadas a la API interna por día                | ~1,03M          | ~10,3M           | Más reintentos                                   |
| Invocaciones de Lambda de la API interna por día | ~2,06M          | ~20,6M           | 2 por llamada                                    |
| Requests SQS FIFO por mes                        | ~65M            | ~650M            | Envío en batch + recepción + borrado por mensaje |
| Almacenamiento en régimen (13 meses)             | ~700 GB         | ~7 TB            | `07-modelo-de-datos.md`                          |

### `MaximumConcurrency` del Worker

Es el parámetro de capacidad más importante y depende de la escala:

- **Mínimo:** la concurrencia promedio con margen. Con 10M son ~127 Workers en curso en promedio: **con `MaximumConcurrency = 100` el sistema no alcanza a 10M** y acumula backlog todo el día. Con 1M, 100 alcanza de sobra para el promedio (~13).
- **Ráfaga del minuto:** el Dispatcher encola el minuto entero de una vez. La simulación de 1M muestra que con 100 un proveedor saturado pierde ~4% de su capacidad diaria esperando turno al comienzo de cada minuto, y que con 1.000 la pérdida desaparece (`04-concurrencia-por-proveedor.md`).
- **Máximo:** lo que tolere la API interna (cada Worker en curso son 2 Lambdas suyas) y Aurora (el proxy multiplexa, pero las transacciones concurrentes cuestan).

Valores iniciales sugeridos: **200 para 1M y 500 para 10M**, a ajustar con una prueba de carga real. Todos los límites de cuenta involucrados (concurrencia de Lambda por cuenta, throughput de SQS FIFO en modo high-throughput, conexiones de RDS Proxy) son **a verificar** en las cuotas de cada servicio; la concurrencia de Lambda por defecto de la cuenta puede requerir un aumento para 10M, considerando que la API interna comparte la cuenta.

### Techo por proveedor

`86.400 / latencia` llamadas por día por proveedor (`04-concurrencia-por-proveedor.md`): 86.400 con 1 s de latencia. Ningún dimensionamiento de AWS lo cambia; solo el sharding `k` (si el proveedor lo admite) o bajar la latencia.

### Aurora

Para 1M, un writer `db.r7g.large` (2 vCPU, 16 GiB) más un reader en otra AZ para failover debería sobrar para ~46 escrituras por segundo. Para 10M (~460 por segundo más el pico de cada minuto), se estima `db.r7g.2xlarge`. Ambos tamaños son **supuestos a validar con una prueba de carga**. Alternativa: Aurora Serverless v2, que escala por ACU; conviene si la carga real resulta muy despareja, pero con una carga pareja las 24 h suele ser más cara que una instancia provisionada (a comparar con los datos de la prueba).

## Costo mensual estimado (`us-east-1`, on-demand)

| Componente                              | 1M        | 10M         | Cálculo                                                                    |
| --------------------------------------- | --------- | ----------- | -------------------------------------------------------------------------- |
| SQS (FIFO + `retry`)                    | $33       | $334        | ~65M / ~650M requests FIFO × $0,50/M, más `retry` × $0,40/M                |
| Lambda Worker                           | $116      | $1.160      | 30M / 300M invocaciones × $0,20/M + 8,25M / 82,5M GB-s × $0,0000133334     |
| Lambda Dispatcher, Requeue y Reconciler | ~$1       | ~$4         | 43.200 ticks por mes, pocos segundos cada uno                              |
| EventBridge Scheduler                   | $0        | $0          | ~44.000 invocaciones por mes, dentro de los 14M gratuitos                  |
| Aurora: cómputo (writer + reader)       | $403      | $1.612      | 2 × `db.r7g.large` / 2 × `db.r7g.2xlarge` × 730 h (precio **a verificar**) |
| Aurora: almacenamiento (en régimen)     | $70       | $700        | ~700 GB / ~7 TB × $0,10/GB-mes                                             |
| Aurora: I/O                             | $48       | $480        | ~8 I/O por job (supuesto) × $0,20/M                                        |
| RDS Proxy                               | $44       | $175        | 4 / 16 vCPU de las instancias × $0,015/vCPU-h × 730 h                      |
| CloudWatch Logs                         | $20       | $222        | ~45 GB / ~450 GB ingeridos × $0,50/GB                                      |
| CloudWatch: métricas y alarmas          | ~$11      | ~$11        | ~30 métricas × $0,30 + ~15 alarmas × $0,10 (sin la dimensión `provider`)   |
| VPC endpoints de interfaz               | $110      | $110        | 5 endpoints × 3 AZ × $0,01/h × 730 h (más $0,01/GB, despreciable)          |
| S3 (payloads > 256 KB)                  | ~$0       | ~$0         | Excepcional por supuesto; $0,023/GB-mes                                    |
| **Total estimado**                      | **~$855** | **~$4.800** |                                                                            |

No incluye: la API interna (sus 2 Lambdas por llamada: solo los requests son ~$12 por mes con 1M y ~$120 con 10M, más su duración), backups de Aurora fuera de la retención gratuita, transferencia de datos, soporte de AWS, ambientes de dev y staging, ni descuentos (Savings Plans y Reserved Instances bajarían el cómputo de Aurora y Lambda de forma significativa).

### Lo que más pesa y cómo bajarlo

- **El Worker cobra mientras espera a la API interna.** Es ~14% del total con 1M y ~24% con 10M, y es proporcional a la latencia supuesta. Mitigación: la menor memoria que alcance (el Worker casi no usa CPU) y Compute Savings Plans.
- **Aurora es el componente más caro** en ambas escalas. Con 10M el almacenamiento y el I/O crecen hasta igualar al cómputo: si el I/O supera ~25% de la factura de Aurora, conviene Aurora I/O-Optimized ($0,225/GB-mes, sin cargo por I/O). Guardar las respuestas en S3 en lugar de `JSONB` reduciría almacenamiento e I/O si resultan más grandes que lo supuesto.
- **Métricas por proveedor: el costo oculto.** Publicar `DownstreamLatency`, `RetryScheduled` y `JobsDeferred` con la dimensión `provider` para 2.000 proveedores serían ~6.000 métricas personalizadas: **~$1.800 por mes**, más que todo el cómputo de 1M. Por eso la recomendación de `08-observabilidad.md` es dejar ese desglose en los logs.
- **Los endpoints de VPC son un costo fijo** (~$110) que pesa con 1M y es marginal con 10M.

## Fuentes de precios (consultadas el 2026-10-28, `us-east-1`)

| Servicio              | Precio usado                                                                                                        | Fuente                                                                                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQS                   | Standard $0,40/M requests · FIFO $0,50/M · 1M gratis por mes · cada 64 KB cuenta como 1 request                     | Price List API de AWS, archivo `AWSQueueService` publicado el 2026-09-11 ([offer file](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSQueueService/current/us-east-1/index.json)); [página de precios](https://aws.amazon.com/sqs/pricing/) |
| Lambda                | $0,20/M requests · Arm $0,0000133334/GB-s (primer tramo) · x86 $0,0000166667/GB-s                                   | Price List API, archivo `AWSLambda` publicado el 2026-10-22 ([offer file](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSLambda/current/us-east-1/index.json)); [página de precios](https://aws.amazon.com/lambda/pricing/)                 |
| EventBridge Scheduler | $1,00/M invocaciones · 14M gratis por mes                                                                           | [Página de precios de EventBridge](https://aws.amazon.com/eventbridge/pricing/)                                                                                                                                                                         |
| Aurora PostgreSQL     | Almacenamiento $0,10/GB-mes · I/O $0,20/M · I/O-Optimized $0,225/GB-mes · Serverless $0,12/ACU-h                    | [Página de precios de Aurora](https://aws.amazon.com/rds/aurora/pricing/) (valores de sus ejemplos de precios)                                                                                                                                          |
| Aurora `db.r7g.large` | **$0,276/h — a verificar** (no figura en la página oficial consultada; fuente secundaria). `2xlarge` estimado en 4× | [Holori](https://calculator.holori.com/aws/rds/db.r7g.large), [Bytebase](https://www.bytebase.com/dbcost/aurora/instance/db.r7g.large/). Verificar en la [calculadora de AWS](https://calculator.aws/)                                                  |
| RDS Proxy             | $0,015 por vCPU-hora (instancias) o por ACU-hora (Serverless)                                                       | Datos de la página oficial de precios de RDS Proxy publicados el 2026-10-26 ([página](https://aws.amazon.com/rds/proxy/pricing/))                                                                                                                       |
| CloudWatch            | Logs $0,50/GB ingerido · métricas personalizadas $0,30 (primeras 10.000) · alarma estándar $0,10                    | [Página de precios de CloudWatch](https://aws.amazon.com/cloudwatch/pricing/) (valores de sus ejemplos)                                                                                                                                                 |
| PrivateLink           | $0,01 por endpoint por AZ por hora · $0,01/GB procesado (primer PB)                                                 | [Página de precios de PrivateLink](https://aws.amazon.com/privatelink/pricing/) (ejemplo en `us-east-1`)                                                                                                                                                |
| S3                    | Standard $0,023/GB-mes (primeros 50 TB) · PUT $0,005 por 1.000                                                      | Price List API, archivo `AmazonS3` publicado el 2026-10-15 ([offer file](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/us-east-1/index.json))                                                                                |

Los precios cambian; antes de usar esta estimación hay que recalcularla en la [calculadora de AWS](https://calculator.aws/) con los volúmenes medidos en la prueba de carga.
