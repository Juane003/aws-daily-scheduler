# ADR-001: Slot wheel de 1.440 minutos

- **Estado:** aceptada
- **Fecha:** 2026-10-28
- **Decisión de CLAUDE.md:** D1

## Contexto

Hay que ejecutar una consulta diaria por registro, repartida a lo largo del día, para 1M de registros hoy y 10M a futuro. Hace falta decidir **en qué momento del día** corre cada registro de una forma que sea pareja, estable y barata de calcular.

## Decisión

Cada registro tiene un slot fijo, `slot = uint32(sha256(registryId)[0..4]) % 1440`, persistido en `registries.slot` con un índice `(slot, id) WHERE enabled`. El slot es el minuto del día de negocio en que el registro se despacha.

## Alternativas consideradas

- **Asignación secuencial (`id % 1440`) o round-robin al insertar:** pareja si los ids son densos, pero depende de cómo se generan; huecos o rangos por cliente desbalancean.
- **Horario aleatorio por día:** reparte bien, pero un registro corre a horas distintas cada día y el despacho necesita una tabla diaria (ver ADR-004).
- **Franjas por proveedor:** agruparía los registros de un proveedor, justo lo contrario de lo que conviene para no saturarlo.

## Consecuencias

- **Positivas:** distribución uniforme verificada (chi-cuadrado sobre 1M de ids; 694 jobs por minuto en promedio, máximo 787, ver `03-distribucion-diaria.md`); estable entre días y despliegues; un solo schedule por minuto alcanza (ADR-002); mover un registro de minuto es un `UPDATE`.
- **Negativas:** el slot no conoce al proveedor, así que no ayuda a un proveedor caliente (su techo lo pone la FIFO, ADR-005). Con una zona horaria con horario de verano, hay días con slots omitidos o repetidos (pregunta P1).

## Referencias

`src/common/slot.ts`, `docs/03-distribucion-diaria.md`
