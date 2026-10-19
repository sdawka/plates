// Pure date helpers: convert a model-supplied local date/time into epoch ms for a given IANA tz.

function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Offset (local - UTC) in ms of `tz` at instant `ts`. */
function tzOffsetMs(ts: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(ts));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** Epoch ms of the wall-clock time y-m-d h:mi in `tz` (falls back to UTC for an unknown tz). */
export function zonedTimeToEpoch(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const zone = isValidTz(tz) ? tz : "UTC";
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - tzOffsetMs(guess, zone);
  const second = guess - tzOffsetMs(first, zone);
  return second;
}

const DUE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/;

/**
 * Parse "YYYY-MM-DD" (end of that day, 23:59 local) or "YYYY-MM-DDTHH:mm" (local wall time)
 * into epoch ms in `tz`. Returns null for anything unparseable or not a real calendar date.
 */
export function parseDue(value: unknown, tz: string): number | null {
  if (typeof value !== "string") return null;
  const m = DUE_RE.exec(value.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const hasTime = m[4] !== undefined && m[5] !== undefined;
  const h = hasTime ? Number(m[4]) : 23;
  const mi = hasTime ? Number(m[5]) : 59;
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59) return null;
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return zonedTimeToEpoch(y, mo, d, h, mi, tz);
}

/** Local calendar date (YYYY-MM-DD) and weekday of `now` in `tz`, for prompts. */
export function localDateInfo(now: number, tz: string): { date: string; weekday: string } {
  const zone = isValidTz(tz) ? tz : "UTC";
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long" }).format(new Date(now));
  return { date, weekday };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The next `count` local calendar dates starting today in `tz`, as YYYY-MM-DD with a label like "Thursday Oct 22". */
export function upcomingDates(now: number, tz: string, count: number): { date: string; label: string }[] {
  const [y, m, d] = localDateInfo(now, tz).date.split("-").map(Number) as [number, number, number];
  return Array.from({ length: count }, (_, i) => {
    const day = new Date(Date.UTC(y, m - 1, d + i));
    return {
      date: day.toISOString().slice(0, 10),
      label: `${WEEKDAYS[day.getUTCDay()]} ${MONTHS[day.getUTCMonth()]} ${day.getUTCDate()}`,
    };
  });
}
