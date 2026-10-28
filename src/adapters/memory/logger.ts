import type { LogFields, LogLevel, Logger } from '../../common/telemetry.js';

export interface LogEvent {
  level: LogLevel;
  message: string;
  fields: LogFields;
}

/** Keeps every event so tests can assert on them. */
export class InMemoryLogger implements Logger {
  readonly events: LogEvent[] = [];

  log(level: LogLevel, message: string, fields: LogFields = {}): void {
    this.events.push({ level, message, fields });
  }

  find(message: string): LogEvent[] {
    return this.events.filter((e) => e.message === message);
  }

  atLevel(level: LogLevel): LogEvent[] {
    return this.events.filter((e) => e.level === level);
  }
}
