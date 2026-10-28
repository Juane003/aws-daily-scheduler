# Simulación de escala (reloj virtual, adaptadores en memoria)

> **Simulación, no benchmark.** Reproduce la semántica del diseño sobre adaptadores en memoria y una API simulada. No mide AWS, Aurora ni la API interna real.

- Registros: 1.000.000 · proveedores: 2.000 · proveedor caliente: 20% · seed: 1
- API simulada: latencia uniforme 200–1000 ms, 5xx 1%, 4xx 0,5% · `MaximumConcurrency` = 1000
- Día simulado: 2026-03-01 (UTC), hasta 2026-03-02T06:10:00.000Z · tiempo real: 76,9 s · heap: 2.486 MB

## Resultado

| Estado               | Jobs    |
| -------------------- | ------- |
| SUCCEEDED            | 973.383 |
| FAILED_NON_RETRYABLE | 4.974   |
| FAILED_EXPIRED       | 21.643  |

Llamadas a la API: 988.238 (0 de otros días) · pico de llamadas simultáneas a un mismo proveedor: **1**

## Distribución por minuto

|                               | Promedio | Mínimo | Máximo | Desvío |
| ----------------------------- | -------- | ------ | ------ | ------ |
| Jobs despachados por minuto   | 694,4    | 585    | 787    | 26,4   |
| Llamadas iniciadas por minuto | 661,2    | 571    | 740    | 24,5   |

## Vaciado por proveedor (sin el caliente)

|                                                    | p50   | p95   | máx   |
| -------------------------------------------------- | ----- | ----- | ----- |
| Mayor demora de un job (s, de encolado a terminal) | 9,9   | 11,9  | 34,2  |
| Último job terminado (h desde el inicio del día)   | 23,95 | 23,98 | 23,99 |

## Proveedor caliente (provider-00001)

|                                                         | Valor   |
| ------------------------------------------------------- | ------- |
| Registros                                               | 199.942 |
| Techo diario `86.400 / latencia media`                  | 144.000 |
| Llamadas iniciadas dentro del día (cualquier resultado) | 144.056 |
| Tiempo ocupado en llamadas dentro del día               | 100%    |
| Exitosos dentro del día                                 | 141.888 |
| Exitosos en total (incluye las 6 h de gracia)           | 177.404 |
| Vencidos (`FAILED_EXPIRED`)                             | 21.643  |
| Mayor demora de un job                                  | 20,18 h |
| ¿Supera el techo?                                       | sí      |

**Arranque en estado estable.** La simulación empieza con el día anterior terminado: sus últimos 5 slots despachados y los registros de sus últimos 70 slots con ejecución `SUCCEEDED`. Sin eso, el lookback del primer tick y el Reconciler de las 00:00:30 encolarían esos jobs del día anterior (es lo que pasaría en un primer despliegue) y consumirían capacidad del proveedor caliente al principio del día. El backlog que un proveedor caliente arrastra de un día a otro no se modela: el día anterior se supone vaciado.

Logs: 984.752 info · 26.630 warn · 0 error
