// Pure scheduling: what is due now and when the next alarm should fire. No Workers imports.

import type { AskRow, RequestRow, UserPrefsRow } from "../types";
import { nextReminderRun } from "./reminders";
import { isWorkingDay, localDayKey, localTimeOnDay, parseHHMM, startOfNextWorkingDay } from "./time";

export type JobKind =
  | { kind: "wake" }
  | { kind: "digest" }
  | { kind: "reminders" }
  | { kind: "nudge"; requestId: string }
  | { kind: "discard"; requestId: string };

export interface Snapshot {
  now: number;
  prefs: UserPrefsRow;
  nextSnoozeWake: number | null;
  pendingRequests: RequestRow[];
  /** Asks on this user's plate that the reminder ladder may cover. */
  reminderAsks?: AskRow[];
}

export interface TimelineEntry {
  at: number;
  job: JobKind;
}

const SCAN_DAYS = 9;

/** The next digest instant: today's slot if it has passed unsent, otherwise the next unsent working-day slot. */
export function nextDigestAt(now: number, prefs: UserPrefsRow): number {
  const { hour, minute } = parseHHMM(prefs.digest_time);
  const tz = prefs.tz;
  const lastKey = prefs.last_digest_at == null ? null : localDayKey(prefs.last_digest_at, tz);
  const todayKey = localDayKey(now, tz);
  for (let i = 0; i < SCAN_DAYS; i++) {
    const t = localTimeOnDay(now, tz, hour, minute, i);
    const key = localDayKey(t, tz);
    if (!isWorkingDay(t, tz) || key === lastKey) continue;
    if (t > now || key === todayKey) return t;
  }
  throw new Error("no digest slot within scan window");
}

/** The nudge or discard time for one pending request in this user's time zone. */
export function confirmDeadline(req: RequestRow, prefs: UserPrefsRow): TimelineEntry {
  const base = req.nudged_at ?? req.created_at;
  const at = startOfNextWorkingDay(base, prefs.tz, prefs.work_start_hour);
  return { at, job: req.nudged_at == null ? { kind: "nudge", requestId: req.id } : { kind: "discard", requestId: req.id } };
}

export function timeline(s: Snapshot): TimelineEntry[] {
  const entries: TimelineEntry[] = [{ at: nextDigestAt(s.now, s.prefs), job: { kind: "digest" } }];
  if (s.nextSnoozeWake != null) entries.push({ at: s.nextSnoozeWake, job: { kind: "wake" } });
  const reminderAt = nextReminderRun(s.reminderAsks ?? [], s.prefs, s.now);
  if (reminderAt != null) entries.push({ at: reminderAt, job: { kind: "reminders" } });
  for (const req of s.pendingRequests) entries.push(confirmDeadline(req, s.prefs));
  return entries;
}

export function computeDue(s: Snapshot): JobKind[] {
  return timeline(s).filter((e) => e.at <= s.now).map((e) => e.job);
}

/** Earliest future-or-overdue job time, or null when nothing is scheduled. */
export function nextAlarmAt(s: Snapshot): number | null {
  const times = timeline(s).map((e) => e.at);
  return times.length > 0 ? Math.min(...times) : null;
}
