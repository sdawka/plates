// Pure reminder ladder math. No Workers imports.
//
// Ladder (all times in the holder's tz, inside working hours on Mon-Fri):
//   owner, accepted/in_progress, deadline: deadline day, next working day, then weekly
//   owner, accepted/in_progress, no deadline: weekly from 7 days after accepted_at
//   proposed, or rejected/clarify on the requester's plate: next working day after it landed, then weekly
//   delivered, snoozed, terminal: never

import type { AskRow, AskState, UserPrefsRow } from "../types";
import { isWorkingDay, localDayKey, localTimeOnDay, startOfNextWorkingDay } from "./time";

const REMINDABLE: readonly AskState[] = ["proposed", "accepted", "in_progress", "rejected", "clarify"];
const SCAN_DAYS = 9;

export function isRemindable(ask: AskRow): boolean {
  return REMINDABLE.includes(ask.state);
}

/** `t` itself when it falls inside working hours, otherwise the start of the next working window. */
export function intoWorkingHours(t: number, prefs: UserPrefsRow): number {
  const { tz, work_start_hour: start, work_end_hour: end } = prefs;
  for (let i = 0; i < SCAN_DAYS; i++) {
    const s = localTimeOnDay(t, tz, start, 0, i);
    if (!isWorkingDay(s, tz)) continue;
    const e = localTimeOnDay(t, tz, end, 0, i);
    if (t < e) return Math.max(t, s);
  }
  throw new Error("no working window within scan range");
}

/** Raw ladder instant for the ask's next reminder, before working-hours adjustment. Null when never reminded. */
function ladderAt(ask: AskRow, prefs: UserPrefsRow): number | null {
  if (!isRemindable(ask)) return null;
  const { tz, work_start_hour: start } = prefs;
  const weekly = (from: number) => localTimeOnDay(from, tz, start, 0, 7);
  const last = ask.last_reminded_at;

  if (ask.state === "accepted" || ask.state === "in_progress") {
    if (ask.deadline_at != null) {
      if (ask.reminder_stage === 0) return localTimeOnDay(ask.deadline_at, tz, start, 0);
      const from = last ?? ask.deadline_at;
      return ask.reminder_stage === 1 ? startOfNextWorkingDay(from, tz, start) : weekly(from);
    }
    return weekly(last ?? ask.accepted_at ?? ask.updated_at);
  }
  // proposed, rejected, clarify: lighter ladder
  if (ask.reminder_stage === 0 || last == null) return startOfNextWorkingDay(last ?? ask.updated_at, tz, start);
  return weekly(last);
}

/**
 * When this ask next wants a reminder, or null if it never will. A value <= now means due now (and now is inside
 * working hours); outside working hours it is the start of the next window. Ignores the daily cap.
 */
export function nextReminderAt(ask: AskRow, prefs: UserPrefsRow, now: number): number | null {
  if (ask.holder_id !== prefs.user_id) return null;
  const raw = ladderAt(ask, prefs);
  if (raw == null) return null;
  const t = intoWorkingHours(raw, prefs);
  if (t > now) return t;
  const open = intoWorkingHours(now, prefs);
  return open > now ? open : t;
}

/** Reminders still allowed on the local day of `at`. */
export function remainingCap(prefs: UserPrefsRow, at: number): number {
  const sent = prefs.reminders_day === localDayKey(at, prefs.tz) ? prefs.reminders_sent : 0;
  return Math.max(0, prefs.max_reminders_per_day - sent);
}

export interface DueSelection {
  due: AskRow[]; // most overdue first, trimmed to the cap
  heldBack: number; // due but over today's cap
}

export function selectDue(asks: AskRow[], prefs: UserPrefsRow, now: number): DueSelection {
  const ranked = asks
    .map((ask) => ({ ask, at: nextReminderAt(ask, prefs, now) }))
    .filter((x): x is { ask: AskRow; at: number } => x.at != null && x.at <= now)
    .sort((a, b) => a.at - b.at || a.ask.created_at - b.ask.created_at || a.ask.id.localeCompare(b.ask.id));
  const room = remainingCap(prefs, now);
  return { due: ranked.slice(0, room).map((x) => x.ask), heldBack: Math.max(0, ranked.length - room) };
}

/** The next instant the keeper should run reminders: earliest ladder time, pushed past any exhausted daily cap. */
export function nextReminderRun(asks: AskRow[], prefs: UserPrefsRow, now: number): number | null {
  const times = asks.map((a) => nextReminderAt(a, prefs, now)).filter((t): t is number => t != null);
  if (times.length === 0) return null;
  let t = Math.min(...times);
  for (let i = 0; i < SCAN_DAYS && remainingCap(prefs, Math.max(t, now)) === 0; i++) {
    t = intoWorkingHours(startOfNextWorkingDay(Math.max(t, now), prefs.tz, prefs.work_start_hour), prefs);
  }
  return t;
}
