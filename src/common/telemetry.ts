/**
 * Logger and Metrics ports (CLAUDE.md §8). The core only depends on these interfaces; in
 * production they would be backed by Powertools (Logger, EMF Metrics, Tracer) through an adapter.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  log(level: LogLevel, message: string, fields?: LogFields): void;
}

export type Dimensions = Readonly<Record<string, string>>;

export interface Metrics {
  /** Adds `value` (default 1) to a counter, e.g. `JobsSucceeded`. */
  count(name: string, dimensions?: Dimensions, value?: number): void;
  /** Records a single observation, e.g. `DownstreamLatency` in ms. */
  record(name: string, value: number, dimensions?: Dimensions): void;
}

/** Default logger: one JSON line per event. `write` is injectable so tests can capture output. */
export class JsonLogger implements Logger {
  constructor(
    private readonly service = 'daily-scheduler',
    private readonly write: (line: string) => void = (line) => process.stdout.write(line),
    private readonly now: () => Date = () => new Date(),
  ) {}

  log(level: LogLevel, message: string, fields: LogFields = {}): void {
    const entry = {
      ...fields,
      timestamp: this.now().toISOString(),
      level,
      service: this.service,
      message,
    };
    this.write(`${JSON.stringify(entry, errorReplacer)}\n`);
  }
}

/** `Error` has no enumerable own properties, so JSON.stringify would emit `{}`. */
function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}
