/**
 * Business-day helpers (CLAUDE.md §4, §6.1). The business day is defined in `businessTz`
 * (default `UTC`, open question P1). Run dates are `YYYY-MM-DD` strings.
 */

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function zonedParts(date: Date, timeZone: string): ZonedParts {
  if (timeZone === 'UTC') {
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
    };
  }
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  const parts: Partial<Record<string, number>> = {};
  for (const part of formatter.formatToParts(date)) parts[part.type] = Number(part.value);
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 0,
    day: parts.day ?? 0,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
  };
}

/** Minute of the business day, 0..1439: the slot that is due at `now`. */
export function minuteOfDay(now: Date, timeZone: string): number {
  const { hour, minute } = zonedParts(now, timeZone);
  return hour * 60 + minute;
}

/** The business date (`YYYY-MM-DD`) that `now` falls in. */
export function businessDate(now: Date, timeZone: string): string {
  const { year, month, day } = zonedParts(now, timeZone);
  return formatDate(year, month, day);
}

/** Calendar arithmetic on a `YYYY-MM-DD` date. */
export function addDays(runDate: string, days: number): string {
  const date = new Date(`${runDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new RangeError(`invalid date: ${runDate}`);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function formatDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The instant the business day `runDate` starts in `timeZone`. Resolves the zone offset by
 * fixed-point iteration, which is exact for whole-minute offsets outside DST transitions.
 */
export function startOfBusinessDay(runDate: string, timeZone: string): Date {
  const target = Date.parse(`${runDate}T00:00:00Z`);
  if (Number.isNaN(target)) throw new RangeError(`invalid date: ${runDate}`);
  let instant = target;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(instant), timeZone);
    const wallClock = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    if (wallClock === target) break;
    instant -= wallClock - target;
  }
  return new Date(instant);
}

/** The instant the business day `runDate` ends (the start of the next one). */
export function endOfBusinessDay(runDate: string, timeZone: string): Date {
  return startOfBusinessDay(addDays(runDate, 1), timeZone);
}
