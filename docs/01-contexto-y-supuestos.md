# 01 — Contexto y supuestos

## El enunciado

Una tabla con N registros (`id, proveedor, endpoint, body`). Cada registro es una consulta a una API interna. Hay que:

- ejecutar **una consulta diaria por registro**, de forma automática y **distribuida a lo largo del día**;
- **guardar el resultado** en una base de datos;
- **manejar errores**: algunos se reintentan y otros no;
- **evitar concurrencia a un mismo proveedor**;
- escalar: 1M de filas hoy, con crecimiento a N veces (el diseño apunta a 10M);
- todo en AWS, en una sola cuenta y región. La API interna ejecuta **2 Lambdas por llamada**.

Se evalúan el diagrama, la justificación de decisiones, el ciclo de vida de desarrollo y el plan de desarrollo.

## Qué es este repositorio

Una **implementación de referencia**: un blueprint arquitectónico respaldado por código TypeScript ejecutable y testeado. No es un sistema listo para producción.

**Incluye:**

- Los algoritmos centrales: slot wheel, Dispatcher con lookback, Worker (deadline, breaker, claim, clasificación y ramas de resultado), circuit breaker, clasificador de errores, backoff, Requeue y Reconciler.
- Puertos (interfaces) para base de datos, colas, HTTP, almacenamiento de objetos, reloj, logs y métricas.
- Adaptadores en memoria que reproducen la semántica de SQS y PostgreSQL que el diseño necesita (un mensaje en vuelo por grupo FIFO, deduplicación, visibility timeout, redrive, `DelaySeconds`, `UNIQUE` y updates condicionales).
- Un reloj virtual, un simulador de la API interna y un harness que corre el pipeline completo, más una simulación de escala de 1M de registros.
- El DDL de PostgreSQL (migraciones), seeds y una herramienta de redrive de la DLQ.
- Esta documentación.

Todo corre con `npm install && npm test`, **sin cuenta de AWS y sin Docker**.

**No incluye** (diseño objetivo o trabajo futuro):

- Despliegue en AWS ni pruebas contra servicios reales. **Nada fue desplegado ni medido en AWS.**
- Adaptadores AWS (SQS, Aurora, S3, HTTP) ni el esqueleto de CDK: la fase 9 se omitió, por prioridad (CLAUDE.md §12).
- Pruebas de carga reales. Se reemplazan por una simulación en memoria con reloj virtual, que valida la semántica del diseño pero **no es un benchmark**.
- Hardening de producción (IAM, red, cifrado, alarmas desplegadas): se documenta como diseño objetivo en `08-observabilidad.md` y `09-seguridad.md`.
- La validación de las migraciones contra un PostgreSQL real (`npm run test:db` con Testcontainers quedó como opcional y no se implementó).

## Supuestos explícitos

Cada supuesto tiene su pregunta abierta en `15-preguntas-abiertas.md`, con el impacto si la respuesta fuera otra.

| #   | Supuesto                                                                                                 | Por qué este valor                                                                        |
| --- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| S1  | El día de negocio es UTC (`businessTz = 'UTC'`).                                                         | Es la única zona sin días de 23 o 25 h; cambiarla es un parámetro.                        |
| S2  | "Distribuida a lo largo del día" significa repartida de forma pareja, sin franjas preferidas.            | El enunciado no pide horarios; un hash uniforme es lo más simple y estable.               |
| S3  | Cada registro corre una vez por día de negocio; el horario exacto dentro del día no importa.             | Permite asignar el minuto por hash y recuperar tarde (lookback, Reconciler).              |
| S4  | "Evitar concurrencia a un proveedor" significa como mucho **una llamada en curso** por proveedor.        | Es la lectura más estricta; el sharding `k` la relaja si un proveedor lo admite.          |
| S5  | La API interna respeta un header `Idempotency-Key`, o repetir una consulta no tiene efectos secundarios. | Es lo que hace segura la entrega at-least-once; si no, queda una ventana de duplicación.  |
| S6  | Los registros se distribuyen entre unos 2.000 proveedores, con alguno "caliente".                        | Es el escenario de la simulación; la distribución real cambia el techo por proveedor.     |
| S7  | Latencia de la API interna de 0,2 a 1 s por llamada (media 0,6 s) en la simulación; 1 s en los costos.   | No hay datos: es el supuesto que más afecta el techo por proveedor y el costo del Worker. |
| S8  | Payload de resultado típico de ~1 KB; los mayores a 256 KB van a S3.                                     | Define el volumen de almacenamiento (`10-capacidad-y-costos.md`).                         |
| S9  | Retención de 13 meses para `executions` y `results`.                                                     | Un año completo más un mes de margen para comparaciones interanuales.                     |
| S10 | Región de referencia para precios: `us-east-1`.                                                          | El enunciado dice "una región" sin nombrarla.                                             |

## Fuera de alcance del sistema (no solo de la implementación)

- **Alta y baja de registros:** la tabla `registries` la mantiene otro proceso. El scheduler solo la lee; el slot se calcula al insertar (`src/common/slot.ts`).
- **Ejecuciones a demanda o con frecuencia distinta a la diaria.** El modelo es "una por registro por día"; otra frecuencia cambia la clave `(registry_id, run_date)`.
- **Consumo de los resultados:** el scheduler los guarda; quién los lee y cómo queda fuera.
- **La API interna:** su escalado, su concurrencia reservada y su manejo de `Idempotency-Key` son del equipo que la mantiene.
