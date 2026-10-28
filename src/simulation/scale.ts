import type { Config } from '../common/config.js';
import { SLOTS_PER_DAY } from '../common/slot.js';
import type { LogFields, LogLevel, Logger } from '../common/telemetry.js';
import { addDays, endOfBusinessDay, startOfBusinessDay } from '../common/time.js';
import { PREVIOUS_DAY_TAIL_SLOTS } from '../core/reconcile/reconciler.js';
import type { ExecutionStatus } from '../core/model.js';
import type { ProviderProfile } from './api-simulator.js';
import { Harness } from './harness.js';
import { generateRegistries, providerName } from './registries.js';

/**
 * Scale simulation (CLAUDE.md §9): one business day of N registries through the full pipeline on a
 * virtual clock, with an optional hot provider. It is a **simulation** of the design's semantics on
 * in-memory adapters — not a benchmark of AWS, Aurora or the internal API.
 */

export interface ScaleOptions {
  rows: number;
  providers: number;
  /** Share of rows (0..1) assigned to `provider-00001`. */
  hotProviderShare: number;
  seed: number;
  runDate: string;
  profile: ProviderProfile;
  esmMaxConcurrency: number;
  config?: Partial<Config>;
}

export const DEFAULT_SCALE_OPTIONS: ScaleOptions = {
  rows: 1_000_000,
  providers: 2000,
  hotProviderShare: 0,
  seed: 1,
  runDate: '2026-03-01',
  profile: { latencyMs: [200, 1000], error5xxRate: 0.01, error4xxRate: 0.005 },
  esmMaxConcurrency: 100,
};

export interface Distribution {
  mean: number;
  min: number;
  max: number;
  stdDev: number;
}

export interface ProviderDrain {
  providerId: string;
  rows: number;
  /** Latest finish minus the job's scheduled minute, in seconds. */
  maxLagS: number;
  /** When the provider's last job of the day reached a terminal state, hours after day start. */
  lastFinishH: number;
  succeeded: number;
  succeededInDay: number;
  expired: number;
}

export interface ScaleReport {
  options: ScaleOptions;
  wallClockS: number;
  heapUsedMb: number;
  simulatedUntil: string;
  statusCounts: Partial<Record<ExecutionStatus, number>>;
  apiCalls: number;
  /** Calls for jobs of other days. Expected 0: the previous day is seeded as finished. */
  previousDayCalls: number;
  peakConcurrencyPerProvider: number;
  /** Jobs dispatched per minute of the day (from `dispatch_windows`). */
  dispatchedPerMinute: Distribution;
  /** API calls started per minute of the day. */
  callsPerMinute: Distribution;
  /** Max-lag and last-finish distributions across non-hot providers. */
  providerLagS: { p50: number; p95: number; max: number };
  providerLastFinishH: { p50: number; p95: number; max: number };
  hotProvider?: ProviderDrain & {
    dailyCeiling: number;
    /** API calls to the hot provider started within the day (any outcome). */
    callsInDay: number;
    /** Simulated time the hot provider spent in calls within the day, as a share of 24 h. */
    busyShare: number;
  };
  logCounts: Record<LogLevel, number>;
}

/** Counts log events instead of keeping them: millions of jobs would not fit in memory. */
export class CountingLogger implements Logger {
  readonly counts: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };
  readonly lastErrors: { message: string; fields: LogFields }[] = [];

  log(level: LogLevel, message: string, fields: LogFields = {}): void {
    this.counts[level]++;
    if (level === 'error' && this.lastErrors.length < 20) this.lastErrors.push({ message, fields });
  }
}

export async function runScaleSimulation(input: Partial<ScaleOptions> = {}): Promise<ScaleReport> {
  const options: ScaleOptions = { ...DEFAULT_SCALE_OPTIONS, ...input };
  const started = performance.now();
  const logger = new CountingLogger();
  const hotId = options.hotProviderShare > 0 ? providerName(0) : undefined;
  const dayStart = startOfBusinessDay(options.runDate, 'UTC');
  const dayEnd = endOfBusinessDay(options.runDate, 'UTC');

  const harness = new Harness({
    start: dayStart,
    registries: generateRegistries({
      rows: options.rows,
      providers: options.providers,
      hotProviderShare: options.hotProviderShare,
      seed: options.seed,
    }),
    seed: options.seed,
    logger,
    esmMaxConcurrency: options.esmMaxConcurrency,
    config: { ...options.config, businessTz: 'UTC' },
    profiles: new Proxy<Record<string, ProviderProfile>>({}, { get: () => options.profile }),
    schedulesUntil: dayEnd,
  });

  await seedPreviousDay(harness, options.runDate, dayStart);

  // Until every job of the day is terminal: the deadline (end of day + expiryGraceH), plus a
  // margin for the last expired messages to drain.
  const until = new Date(dayEnd.getTime() + (harness.config.expiryGraceH * 60 + 10) * 60_000);
  await harness.runUntil(until);

  // Dispatched per minute, from the windows the Dispatcher completed.
  const dispatched: number[] = [];
  for (let slot = 0; slot < SLOTS_PER_DAY; slot++) {
    const window = await harness.repository.getDispatchWindow(options.runDate, slot);
    dispatched.push(window?.jobsDispatched ?? 0);
  }
  // Only calls for this day's jobs. With the previous day seeded as finished there should be none
  // for other days; the count is reported as a check.
  const calls = new Array<number>(SLOTS_PER_DAY).fill(0);
  let previousDayJobs = 0;
  for (const call of harness.api.calls) {
    if (!call.idempotencyKey.endsWith(`#${options.runDate}`)) {
      previousDayJobs++;
      continue;
    }
    const minute = Math.floor((call.startedAt - dayStart.getTime()) / 60_000);
    if (minute >= 0 && minute < SLOTS_PER_DAY) calls[minute] = (calls[minute] ?? 0) + 1;
  }

  const drains = providerDrains(harness, options.runDate, dayStart, dayEnd);
  const others = [...drains.values()].filter((d) => d.providerId !== hotId);
  const hot = hotId === undefined ? undefined : drains.get(hotId);
  const [min, max] = options.profile.latencyMs;
  const meanLatencyS = (min + max) / 2 / 1000;

  const report: ScaleReport = {
    options,
    wallClockS: (performance.now() - started) / 1000,
    heapUsedMb: process.memoryUsage().heapUsed / 1e6,
    simulatedUntil: until.toISOString(),
    statusCounts: harness.statusCounts(options.runDate),
    apiCalls: harness.api.calls.length,
    previousDayCalls: previousDayJobs,
    peakConcurrencyPerProvider: Math.max(0, ...harness.api.peakConcurrency().values()),
    dispatchedPerMinute: distribution(dispatched),
    callsPerMinute: distribution(calls),
    providerLagS: percentiles(others.map((d) => d.maxLagS)),
    providerLastFinishH: percentiles(others.map((d) => d.lastFinishH)),
    logCounts: { ...logger.counts },
  };
  if (hot !== undefined && hotId !== undefined) {
    let callsInDay = 0;
    let busyMs = 0;
    for (const c of harness.api.callsTo(hotId)) {
      if (c.startedAt >= dayEnd.getTime()) continue;
      callsInDay++;
      busyMs += Math.min(c.endedAt, dayEnd.getTime()) - c.startedAt;
    }
    report.hotProvider = {
      ...hot,
      dailyCeiling: 86_400 / meanLatencyS,
      callsInDay,
      busyShare: busyMs / 86_400_000,
    };
  }
  return report;
}

/**
 * Marks the previous day as finished where the first run would otherwise touch it: the windows the
 * lookback revisits and the tail the Reconciler checks (see `PREVIOUS_DAY_TAIL_SLOTS`).
 */
async function seedPreviousDay(harness: Harness, runDate: string, dayStart: Date): Promise<void> {
  const previous = addDays(runDate, -1);
  const repo = harness.repository;
  for (let slot = SLOTS_PER_DAY - harness.config.lookbackSlots; slot < SLOTS_PER_DAY; slot++) {
    await repo.beginDispatchWindow(previous, slot, dayStart);
    await repo.completeDispatchWindow(previous, slot, 0, dayStart);
  }
  for (let slot = SLOTS_PER_DAY - PREVIOUS_DAY_TAIL_SLOTS; slot < SLOTS_PER_DAY; slot++) {
    for (let after: string | null = null; ;) {
      const page = await repo.listRegistriesBySlot(slot, after, 1000);
      const last = page.at(-1);
      if (last === undefined) break;
      after = last.id;
      await repo.insertExecutions(
        page.map((r) => ({ registryId: r.id, runDate: previous, providerId: r.providerId })),
        dayStart,
      );
      for (const r of page) {
        await repo.updateExecution(
          { registryId: r.id, runDate: previous },
          { status: ['ENQUEUED'] },
          { status: 'SUCCEEDED', finishedAt: dayStart },
        );
      }
    }
  }
}

function providerDrains(
  harness: Harness,
  runDate: string,
  dayStart: Date,
  dayEnd: Date,
): Map<string, ProviderDrain> {
  const drains = new Map<string, ProviderDrain>();
  // `seq`/`slot` are not on the execution row; enqueued_at of the first dispatch is the scheduled
  // minute (the Dispatcher inserts the row in the tick of its slot).
  for (const e of harness.repository.allExecutions()) {
    if (e.runDate !== runDate) continue;
    let d = drains.get(e.providerId);
    if (d === undefined) {
      d = {
        providerId: e.providerId,
        rows: 0,
        maxLagS: 0,
        lastFinishH: 0,
        succeeded: 0,
        succeededInDay: 0,
        expired: 0,
      };
      drains.set(e.providerId, d);
    }
    d.rows++;
    if (e.status === 'SUCCEEDED') d.succeeded++;
    if (e.status === 'FAILED_EXPIRED') d.expired++;
    if (e.finishedAt === null) continue;
    const finished = e.finishedAt.getTime();
    if (e.status === 'SUCCEEDED' && finished < dayEnd.getTime()) d.succeededInDay++;
    d.maxLagS = Math.max(d.maxLagS, (finished - e.enqueuedAt.getTime()) / 1000);
    d.lastFinishH = Math.max(d.lastFinishH, (finished - dayStart.getTime()) / 3_600_000);
  }
  return drains;
}

export function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) return { mean: 0, min: 0, max: 0, stdDev: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, min: Math.min(...values), max: Math.max(...values), stdDev: Math.sqrt(variance) };
}

export function percentiles(values: readonly number[]): { p50: number; p95: number; max: number } {
  if (values.length === 0) return { p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? 0 };
}

const fmt = (n: number, digits = 1) =>
  n.toLocaleString('es-AR', { maximumFractionDigits: digits, minimumFractionDigits: 0 });

/** Markdown report, in Spanish like the rest of `docs/`. */
export function formatReport(r: ScaleReport): string {
  const o = r.options;
  const lines = [
    '# Simulación de escala (reloj virtual, adaptadores en memoria)',
    '',
    '> **Simulación, no benchmark.** Reproduce la semántica del diseño sobre adaptadores en memoria y una API simulada. No mide AWS, Aurora ni la API interna real.',
    '',
    `- Registros: ${fmt(o.rows, 0)} · proveedores: ${fmt(o.providers, 0)} · proveedor caliente: ${fmt(o.hotProviderShare * 100)}% · seed: ${o.seed}`,
    `- API simulada: latencia uniforme ${o.profile.latencyMs[0]}–${o.profile.latencyMs[1]} ms, 5xx ${fmt(o.profile.error5xxRate * 100)}%, 4xx ${fmt(o.profile.error4xxRate * 100)}% · \`MaximumConcurrency\` = ${o.esmMaxConcurrency}`,
    `- Día simulado: ${o.runDate} (UTC), hasta ${r.simulatedUntil} · tiempo real: ${fmt(r.wallClockS)} s · heap: ${fmt(r.heapUsedMb, 0)} MB`,
    '',
    '## Resultado',
    '',
    '| Estado | Jobs |',
    '| --- | --- |',
    ...Object.entries(r.statusCounts).map(([s, n]) => `| ${s} | ${fmt(n, 0)} |`),
    '',
    `Llamadas a la API: ${fmt(r.apiCalls, 0)} (${fmt(r.previousDayCalls, 0)} de otros días) · pico de llamadas simultáneas a un mismo proveedor: **${r.peakConcurrencyPerProvider}**`,
    '',
    '## Distribución por minuto',
    '',
    '| | Promedio | Mínimo | Máximo | Desvío |',
    '| --- | --- | --- | --- | --- |',
    `| Jobs despachados por minuto | ${fmt(r.dispatchedPerMinute.mean)} | ${fmt(r.dispatchedPerMinute.min, 0)} | ${fmt(r.dispatchedPerMinute.max, 0)} | ${fmt(r.dispatchedPerMinute.stdDev)} |`,
    `| Llamadas iniciadas por minuto | ${fmt(r.callsPerMinute.mean)} | ${fmt(r.callsPerMinute.min, 0)} | ${fmt(r.callsPerMinute.max, 0)} | ${fmt(r.callsPerMinute.stdDev)} |`,
    '',
    '## Vaciado por proveedor (sin el caliente)',
    '',
    '| | p50 | p95 | máx |',
    '| --- | --- | --- | --- |',
    `| Mayor demora de un job (s, de encolado a terminal) | ${fmt(r.providerLagS.p50)} | ${fmt(r.providerLagS.p95)} | ${fmt(r.providerLagS.max)} |`,
    `| Último job terminado (h desde el inicio del día) | ${fmt(r.providerLastFinishH.p50, 2)} | ${fmt(r.providerLastFinishH.p95, 2)} | ${fmt(r.providerLastFinishH.max, 2)} |`,
  ];
  const h = r.hotProvider;
  if (h !== undefined) {
    lines.push(
      '',
      `## Proveedor caliente (${h.providerId})`,
      '',
      '| | Valor |',
      '| --- | --- |',
      `| Registros | ${fmt(h.rows, 0)} |`,
      `| Techo diario \`86.400 / latencia media\` | ${fmt(h.dailyCeiling, 0)} |`,
      `| Llamadas iniciadas dentro del día (cualquier resultado) | ${fmt(h.callsInDay, 0)} |`,
      `| Tiempo ocupado en llamadas dentro del día | ${fmt(h.busyShare * 100)}% |`,
      `| Exitosos dentro del día | ${fmt(h.succeededInDay, 0)} |`,
      `| Exitosos en total (incluye las ${o.config?.expiryGraceH ?? 6} h de gracia) | ${fmt(h.succeeded, 0)} |`,
      `| Vencidos (\`FAILED_EXPIRED\`) | ${fmt(h.expired, 0)} |`,
      `| Mayor demora de un job | ${fmt(h.maxLagS / 3600, 2)} h |`,
      `| ¿Supera el techo? | ${h.rows > h.dailyCeiling ? 'sí' : 'no'} |`,
    );
  }
  lines.push(
    '',
    '**Arranque en estado estable.** La simulación empieza con el día anterior terminado: sus últimos 5 slots despachados y los registros de sus últimos 70 slots con ejecución `SUCCEEDED`. Sin eso, el lookback del primer tick y el Reconciler de las 00:00:30 encolarían esos jobs del día anterior (es lo que pasaría en un primer despliegue) y consumirían capacidad del proveedor caliente al principio del día. El backlog que un proveedor caliente arrastra de un día a otro no se modela: el día anterior se supone vaciado.',
    '',
    `Logs: ${fmt(r.logCounts.info, 0)} info · ${fmt(r.logCounts.warn, 0)} warn · ${fmt(r.logCounts.error, 0)} error`,
    '',
  );
  return lines.join('\n');
}
