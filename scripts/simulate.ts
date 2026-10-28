/**
 * Scale simulation CLI (CLAUDE.md §9). A simulation on a virtual clock with in-memory adapters,
 * not a benchmark of AWS.
 *
 *   npm run simulate -- --rows 1000000 --providers 2000 --hot-provider 0.2
 *   npm run simulate -- --rows 100000 --out docs/simulacion/100k.md --json docs/simulacion/100k.json
 */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  DEFAULT_SCALE_OPTIONS,
  formatReport,
  runScaleSimulation,
} from '../src/simulation/scale.js';

const d = DEFAULT_SCALE_OPTIONS;
const { values } = parseArgs({
  options: {
    rows: { type: 'string', default: String(d.rows) },
    providers: { type: 'string', default: String(d.providers) },
    'hot-provider': { type: 'string', default: String(d.hotProviderShare) },
    seed: { type: 'string', default: String(d.seed) },
    'latency-min': { type: 'string', default: String(d.profile.latencyMs[0]) },
    'latency-max': { type: 'string', default: String(d.profile.latencyMs[1]) },
    'error-5xx': { type: 'string', default: String(d.profile.error5xxRate) },
    'error-4xx': { type: 'string', default: String(d.profile.error4xxRate) },
    concurrency: { type: 'string', default: String(d.esmMaxConcurrency) },
    out: { type: 'string' },
    json: { type: 'string' },
  },
});

const report = await runScaleSimulation({
  rows: Number(values.rows),
  providers: Number(values.providers),
  hotProviderShare: Number(values['hot-provider']),
  seed: Number(values.seed),
  profile: {
    latencyMs: [Number(values['latency-min']), Number(values['latency-max'])],
    error5xxRate: Number(values['error-5xx']),
    error4xxRate: Number(values['error-4xx']),
  },
  esmMaxConcurrency: Number(values.concurrency),
});

const markdown = formatReport(report);
process.stdout.write(markdown);
if (values.out !== undefined) await writeFile(values.out, markdown);
if (values.json !== undefined) await writeFile(values.json, `${JSON.stringify(report, null, 2)}\n`);
