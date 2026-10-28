/**
 * DLQ redrive helper — reference implementation, not run against AWS. It works offline on
 * exported DLQ bodies, so it needs no AWS SDK:
 *
 *   # 1. Export the bodies, one per line (e.g. with `aws sqs receive-message` in a loop).
 *   # 2. Build the redrive:
 *   npm run redrive -- --in dlq-bodies.jsonl --out redrive/2026-03-01
 *   # 3. Run redrive/2026-03-01.sql against Aurora (resets the rows to RETRYING).
 *   # 4. Send each redrive/2026-03-01-NNN.json with:
 *   #    aws sqs send-message-batch --queue-url "$FIFO_URL" --entries file://redrive/2026-03-01-001.json
 *   # 5. Delete the redriven messages from the DLQ.
 *
 * Expired jobs (`EXPIRED`) are skipped: their business day is over, re-running them under the same
 * run date would expire them again. Unreadable bodies are listed for manual inspection.
 * See docs/14-runbook.md.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { chunk } from '../src/common/concurrency.js';
import { defaults } from '../src/common/config.js';
import { nextMessage, readDeadLetter, toFifoMessage } from '../src/common/message.js';

const { values } = parseArgs({
  options: {
    in: { type: 'string' },
    out: { type: 'string', default: 'redrive/redrive' },
    shards: { type: 'string', default: String(defaults.providerShards) },
  },
});
if (values.in === undefined) throw new Error('--in <file with one DLQ body per line> is required');

const lines = (await readFile(values.in, 'utf8')).split('\n').filter((l) => l.trim() !== '');
const sql: string[] = ['BEGIN;'];
const entries: {
  Id: string;
  MessageBody: string;
  MessageGroupId: string;
  MessageDeduplicationId: string;
}[] = [];
const skipped: { line: number; reason: string; detail: string }[] = [];
const seen = new Set<string>();

lines.forEach((body, i) => {
  const letter = readDeadLetter(body);
  if (letter.kind === 'UNREADABLE') {
    skipped.push({ line: i + 1, reason: letter.reason, detail: letter.error });
    return;
  }
  const { message } = letter;
  if (letter.reason === 'EXPIRED') {
    skipped.push({ line: i + 1, reason: 'EXPIRED', detail: message.jobId });
    return;
  }
  if (seen.has(message.jobId)) return;
  seen.add(message.jobId);
  // Fresh attempts: the redrive follows a fix (credentials, a bug, the provider recovered).
  const next = nextMessage(message, 'RETRY', 0);
  sql.push(
    `UPDATE executions SET status = 'RETRYING', attempt = 0, seq = ${next.seq}, ` +
      `next_attempt_at = now(), finished_at = NULL ` +
      `WHERE registry_id = ${message.registryId} AND run_date = DATE '${message.runDate}' ` +
      `AND status <> 'SUCCEEDED';`,
  );
  const fifo = toFifoMessage(next, Number(values.shards));
  entries.push({
    Id: String(entries.length % 10),
    MessageBody: fifo.body,
    MessageGroupId: fifo.groupId,
    MessageDeduplicationId: fifo.deduplicationId,
  });
});
sql.push('COMMIT;');

await mkdir(dirname(values.out), { recursive: true });
await writeFile(`${values.out}.sql`, `${sql.join('\n')}\n`);
const batches = chunk(entries, 10);
for (const [i, batch] of batches.entries()) {
  const ids = batch.map((e, j) => ({ ...e, Id: String(j) }));
  await writeFile(
    `${values.out}-${String(i + 1).padStart(3, '0')}.json`,
    `${JSON.stringify(ids, null, 2)}\n`,
  );
}
await writeFile(`${values.out}-skipped.json`, `${JSON.stringify(skipped, null, 2)}\n`);
process.stdout.write(
  `${entries.length} jobs to redrive in ${batches.length} batches, ${skipped.length} skipped\n` +
    `SQL: ${values.out}.sql · batches: ${values.out}-NNN.json · skipped: ${values.out}-skipped.json\n`,
);
