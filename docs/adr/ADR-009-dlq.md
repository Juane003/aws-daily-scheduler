# ADR-009: DLQ FIFO y DLQ de retry

- **Estado:** aceptada
- **Fecha:** 2026-10-28
- **Decisión de CLAUDE.md:** D9

## Contexto

Algunos jobs no pueden terminar bien: errores no reintentables, intentos agotados, días vencidos, mensajes inválidos o poison messages que hacen fallar al Worker. Tienen que quedar visibles y recuperables, nunca descartados en silencio.

## Decisión

Una DLQ FIFO recibe los terminales que envía el Worker (con un sobre `{reason, error, failedAt, message | raw}`) y los poison messages que mueve la redrive policy de la FIFO (`maxReceiveCount = 3`). La cola `retry` tiene su propia DLQ standard. Cualquier DLQ con mensajes dispara una alarma. Un script de redrive genera el SQL para resetear las filas y los batches para devolver los mensajes a la FIFO.

## Alternativas consideradas

- **Solo el estado en la base (`FAILED_*`), sin DLQ:** sin un lugar natural para mensajes inválidos o poison, ni una alarma nativa de SQS.
- **Una sola DLQ standard para todo:** la redrive policy de SQS exige que la DLQ de una FIFO sea FIFO.

## Consecuencias

- **Positivas:** cuarentena observable con un camino de redrive probado (`npm run redrive`); el sobre distingue los motivos; los mensajes no llevan datos sensibles, solo ids.
- **Negativas:** dos formatos en la misma DLQ (sobre y mensaje "pelado"), que la herramienta de redrive acepta; el Worker envía a la DLQ **antes** de escribir el estado terminal para no perder la carta.

## Referencias

`src/common/message.ts`, `scripts/redrive-dlq.ts`, `docs/14-runbook.md`
