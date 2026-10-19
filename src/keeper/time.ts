// Pure timezone and working-day math on Intl.DateTimeFormat. No dependencies, no Workers imports.

const DAY_MS = 86_400_000;

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

export function localParts(ms: number, tz: string): LocalParts {
  const p: Record<string, string> = {};
  for (const part of formatter(tz).formatToParts(new Date(ms))) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: WEEKDAYS.indexOf(p.weekday ?? ""),
  };
}

/** Offset of `tz` from UTC at instant `ms`, in milliseconds (east is positive). */
export function offsetAt(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * UTC instant of a local wall time. In a DST overlap (clocks go back) the first occurrence wins;
 * in a gap (clocks go forward) the time is pushed forward by the gap.
 */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set([offsetAt(guess - DAY_MS, tz), offsetAt(guess + DAY_MS, tz)]);
  const candidates = [...offsets].map((o) => guess - o);
  const valid = candidates.filter((c) => offsetAt(c, tz) === guess - c);
  return valid.length > 0 ? Math.min(...valid) : Math.max(...candidates);
}

export function parseHHMM(hhmm: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  const hour = m ? Number(m[1]) : 9;
  const minute = m ? Number(m[2]) : 0;
  return hour < 24 && minute < 60 ? { hour, minute } : { hour: 9, minute: 0 };
}

/** Local calendar day as "YYYY-MM-DD". */
export function localDayKey(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Monday to Friday in `tz`. */
export function isWorkingDay(ms: number, tz: string): boolean {
  const wd = localParts(ms, tz).weekday;
  return wd >= 1 && wd <= 5;
}

/** The instant of hour:minute local time on the local day of `ms`, shifted by `dayOffset` calendar days. */
export function localTimeOnDay(ms: number, tz: string, hour: number, minute: number, dayOffset = 0): number {
  const p = localParts(ms, tz);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + dayOffset));
  return zonedTimeToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hour, minute, tz);
}

/** First instant strictly after `nowMs` whose local wall time is `hhmm`, optionally on Mon-Fri only. */
export function nextLocalTime(nowMs: number, tz: string, hhmm: string, workingDaysOnly: boolean): number {
  const { hour, minute } = parseHHMM(hhmm);
  for (let i = 0; i < 9; i++) {
    const t = localTimeOnDay(nowMs, tz, hour, minute, i);
    if (t > nowMs && (!workingDaysOnly || isWorkingDay(t, tz))) return t;
  }
  throw new Error("no matching local time within 9 days");
}

/** `hour`:00 local on the first working day strictly after the local day of `ms`. */
export function startOfNextWorkingDay(ms: number, tz: string, hour: number): number {
  for (let i = 1; i < 9; i++) {
    const t = localTimeOnDay(ms, tz, hour, 0, i);
    if (isWorkingDay(t, tz)) return t;
  }
  throw new Error("no working day within 9 days");
}
