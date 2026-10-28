# Simulación de escala (reloj virtual, adaptadores en memoria)

> **Simulación, no benchmark.** Reproduce la semántica del diseño sobre adaptadores en memoria y una API simulada. No mide AWS, Aurora ni la API interna real.

- Registros: 1.000.000 · proveedores: 2.000 · proveedor caliente: 20% · seed: 1
- API simulada: latencia uniforme 200–1000 ms, 5xx 1%, 4xx 0,5% · `MaximumConcurrency` = 100
- Día simulado: 2026-03-01 (UTC), hasta 2026-03-02T06:10:00.000Z · tiempo real: 82,6 s · heap: 1.989 MB

## Resultado

| Estado               | Jobs    |
| -------------------- | ------- |
| SUCCEEDED            | 967.768 |
| FAILED_NON_RETRYABLE | 4.912   |
| FAILED_EXPIRED       | 27.320  |

Llamadas a la API: 982.513 (0 de otros días) · pico de llamadas simultáneas a un mismo proveedor: **1**

## Distribución por minuto

|                               | Promedio | Mínimo | Máximo | Desvío |
| ----------------------------- | -------- | ------ | ------ | ------ |
| Jobs despachados por minuto   | 694,4    | 585    | 787    | 26,4   |
| Llamadas iniciadas por minuto | 657,3    | 568    | 733    | 24,2   |

## Vaciado por proveedor (sin el caliente)

|                                                    | p50   | p95   | máx   |
| -------------------------------------------------- | ----- | ----- | ----- |
| Mayor demora de un job (s, de encolado a terminal) | 11,2  | 14    | 55,4  |
| Último job terminado (h desde el inicio del día)   | 23,95 | 23,98 | 23,99 |

## Proveedor caliente (provider-00001)

|                                                         | Valor   |
| ------------------------------------------------------- | ------- |
| Registros                                               | 199.942 |
| Techo diario `86.400 / latencia media`                  | 144.000 |
| Llamadas iniciadas dentro del día (cualquier resultado) | 138.339 |
| Tiempo ocupado en llamadas dentro del día               | 96,2%   |
| Exitosos dentro del día                                 | 136.213 |
| Exitosos en total (incluye las 6 h de gracia)           | 171.746 |
| Vencidos (`FAILED_EXPIRED`)                             | 27.320  |
| Mayor demora de un job                                  | 18,05 h |
| ¿Supera el techo?                                       | sí      |

**Arranque en estado estable.** La simulación empieza con el día anterior terminado: sus últimos 5 slots despachados y los registros de sus últimos 70 slots con ejecución `SUCCEEDED`. Sin eso, el lookback del primer tick y el Reconciler de las 00:00:30 encolarían esos jobs del día anterior (es lo que pasaría en un primer despliegue) y consumirían capacidad del proveedor caliente al principio del día. El backlog que un proveedor caliente arrastra de un día a otro no se modela: el día anterior se supone vaciado.

Logs: 979.089 info · 32.246 warn · 0 error
