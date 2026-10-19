// Timezone-aware time helpers for deadlines and snooze presets. Pure (Intl only).

export type SnoozePreset = "2h" | "tomorrow" | "monday" | "custom";

interface LocalParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  dow: number; // 0 = Sunday
}

const safeTz = (tz: string): string => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
};

function localParts(ms: number, tzIn: string): LocalParts {
  const tz = safeTz(tzIn);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(new Date(Math.floor(ms / 1000) * 1000))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const dow = new Date(Date.UTC(p.year!, p.month! - 1, p.day!)).getUTCDay();
  return { y: p.year!, mo: p.month!, d: p.day!, h: p.hour!, mi: p.minute!, dow };
}

/** Epoch ms for a wall-clock time in `tz`. Day overflow (d + n) is normalised. */
export function zonedToEpoch(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  const at = (t: number) => {
    const p = localParts(t, tz);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(t / 60000) * 60000;
  };
  const first = asUtc - at(asUtc);
  return asUtc - at(first);
}

/** End of the given YYYY-MM-DD day (23:59) in `tz`. */
export function endOfDay(date: string, tz: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  return zonedToEpoch(Number(m[1]), Number(m[2]), Number(m[3]), 23, 59, tz);
}

/** YYYY-MM-DD of an instant in `tz` (for datepicker initial_date). */
export function dateInTz(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

export function snoozeUntil(preset: Exclude<SnoozePreset, "custom">, now: number, tz: string): number {
  if (preset === "2h") return now + 2 * 3600_000;
  const p = localParts(now, tz);
  const addDays = preset === "tomorrow" ? 1 : (1 - p.dow + 7) % 7 || 7;
  return zonedToEpoch(p.y, p.mo, p.d + addDays, 9, 0, tz);
}
