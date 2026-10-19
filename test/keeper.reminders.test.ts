import { describe, expect, it } from "vitest";
import { defaultPrefs } from "../src/domain/repo";
import { nextReminderAt, nextReminderRun, selectDue } from "../src/keeper/reminders";
import { computeDue, nextAlarmAt, type Snapshot } from "../src/keeper/schedule";
import { buildDigest } from "../src/keeper/digest";
import { zonedTimeToUtc } from "../src/keeper/time";
import type { AskRow, UserPrefsRow } from "../src/types";

const ME = "UME";
const NY = "America/New_York";
const DAY = 86_400_000;

// 2026-10-19 is a Monday.
const at = (d: number, h: number, m = 0, tz = "UTC", month = 10) => zonedTimeToUtc(2026, month, d, h, m, tz);

function prefs(over: Partial<UserPrefsRow> = {}): UserPrefsRow {
  return { ...defaultPrefs(ME), updated_at: 1, ...over };
}

function ask(over: Partial<AskRow>): AskRow {
  return {
    id: "a", request_id: "r", requester_id: "UDANA", owner_id: ME, holder_id: ME, title: "Q3 numbers",
    detail: null, type: "deliverable", state: "accepted", snoozed_from: null, size: "hours",
    size_source: "llm", urgency: "normal", urgency_source: "llm", estimate_reason: null,
    inferred_due_at: null, deadline_at: null, deadline_change_count: 0, snoozed_until: null,
    snooze_count: 0, round_count: 0, source_ts: null, source_permalink: null, next_step: null,
    done_link: null, last_note: null, created_at: 1, accepted_at: at(12, 10), closed_at: null, updated_at: at(12, 10),
    reminder_stage: 0, last_reminded_at: null, last_bumped_at: null, tracker_ref: null, tracker_url: null,
    ...over,
  };
}

const next = (a: AskRow, p = prefs(), now = at(19, 8)) => nextReminderAt(a, p, now);

describe("deadline ladder", () => {
  it("stage 0 is work start on the deadline day", () => {
    expect(next(ask({ deadline_at: at(21, 15) }))).toBe(at(21, 9));
  });

  it("deadline today within working hours is due immediately", () => {
    const now = at(19, 11);
    const a = ask({ deadline_at: at(19, 17) });
    expect(next(a, prefs(), now)).toBeLessThanOrEqual(now);
    expect(selectDue([a], prefs(), now).due).toHaveLength(1);
  });

  it("deadline today but before working hours waits for work start", () => {
    expect(next(ask({ deadline_at: at(19, 17) }), prefs(), at(19, 7))).toBe(at(19, 9));
  });

  it("deadline today but after working hours rolls to the next working day", () => {
    const now = at(19, 18);
    const t = next(ask({ deadline_at: at(19, 20) }), prefs(), now)!;
    expect(t).toBe(at(20, 9));
  });

  it("past deadline is due at once during working hours", () => {
    const now = at(21, 10);
    expect(selectDue([ask({ deadline_at: at(14, 12) })], prefs(), now).due).toHaveLength(1);
  });

  it("stage 1 is the next working day after the last reminder", () => {
    const a = ask({ deadline_at: at(21, 15), reminder_stage: 1, last_reminded_at: at(21, 9) });
    expect(next(a)).toBe(at(22, 9));
  });

  it("stage 1 on Friday rolls over the weekend", () => {
    const a = ask({ deadline_at: at(23, 15), reminder_stage: 1, last_reminded_at: at(23, 9) });
    expect(next(a)).toBe(at(26, 9));
  });

  it("stage 2+ is weekly on the same weekday", () => {
    const a = ask({ deadline_at: at(21, 15), reminder_stage: 2, last_reminded_at: at(22, 9) });
    expect(next(a)).toBe(at(29, 9));
    expect(next({ ...a, reminder_stage: 5, last_reminded_at: at(29, 9) })).toBe(at(11 - 11 + 5, 9, 0, "UTC", 11));
  });

  it("deadline on a weekend reminds on Monday", () => {
    expect(next(ask({ deadline_at: at(24, 12) }))).toBe(at(26, 9));
  });

  it("a late first reminder shifts the later steps", () => {
    const a = ask({ deadline_at: at(19, 15), reminder_stage: 1, last_reminded_at: at(21, 9) });
    expect(next(a)).toBe(at(22, 9));
  });
});

describe("other ladders", () => {
  it("no deadline: weekly from 7 days after acceptance", () => {
    const a = ask({ accepted_at: at(12, 10) });
    expect(next(a)).toBe(at(19, 9));
    expect(next({ ...a, reminder_stage: 1, last_reminded_at: at(19, 9) })).toBe(at(26, 9));
  });

  it("no deadline stays quiet before the 7 days are up", () => {
    const a = ask({ accepted_at: at(15, 10) });
    expect(next(a)).toBe(at(22, 9));
  });

  it("proposed: next working day after it landed, then weekly", () => {
    const a = ask({ state: "proposed", accepted_at: null, updated_at: at(19, 14) });
    expect(next(a)).toBe(at(20, 9));
    expect(next({ ...a, reminder_stage: 1, last_reminded_at: at(20, 9) })).toBe(at(27, 9));
  });

  it("proposed landing on Friday waits for Monday", () => {
    expect(next(ask({ state: "proposed", updated_at: at(23, 14) }))).toBe(at(26, 9));
  });

  it("rejected and clarify remind the requester like proposed", () => {
    for (const state of ["rejected", "clarify"] as const) {
      const a = ask({ state, holder_id: "UDANA", updated_at: at(19, 14) });
      expect(nextReminderAt(a, prefs({ user_id: "UDANA" }), at(19, 15))).toBe(at(20, 9));
    }
  });

  it("never reminds delivered, snoozed, terminal asks", () => {
    for (const state of ["delivered", "snoozed", "closed", "withdrawn"] as const) {
      expect(next(ask({ state, deadline_at: at(19, 12) }))).toBeNull();
    }
  });

  it("only reminds the holder", () => {
    expect(next(ask({ holder_id: "UOTHER", deadline_at: at(19, 12) }))).toBeNull();
  });
});

describe("working hours and time zones", () => {
  it("does not fire outside working hours", () => {
    const a = ask({ deadline_at: at(19, 12) });
    expect(selectDue([a], prefs(), at(19, 18)).due).toHaveLength(0);
    expect(selectDue([a], prefs(), at(19, 10)).due).toHaveLength(1);
    expect(selectDue([a], prefs(), at(24, 10)).due).toHaveLength(0); // Saturday
    expect(next(a, prefs(), at(24, 10))).toBe(at(24, 10) > at(19, 12) ? at(26, 9) : null);
  });

  it("uses the holder's tz and work hours", () => {
    const p = prefs({ tz: NY, work_start_hour: 8, work_end_hour: 16 });
    expect(next(ask({ deadline_at: at(21, 12, 0, NY) }), p)).toBe(at(21, 8, 0, NY));
  });

  it("keeps work start across the DST change (weekly, New York)", () => {
    // US clocks go back on 2026-11-01.
    const p = prefs({ tz: NY });
    const a = ask({ deadline_at: at(21, 15, 0, NY), reminder_stage: 2, last_reminded_at: at(26, 9, 0, NY) });
    expect(next(a, p)).toBe(at(2, 9, 0, NY, 11));
    expect(at(2, 9, 0, NY, 11) - at(26, 9, 0, NY)).toBe(7 * DAY + 3_600_000);
  });

  it("next-working-day step across DST", () => {
    const p = prefs({ tz: NY });
    const a = ask({ state: "proposed", updated_at: at(30, 15, 0, NY) }); // Friday Oct 30
    expect(next(a, p)).toBe(at(2, 9, 0, NY, 11)); // Monday after the change
  });
});

describe("stage reset", () => {
  it("a reset ask (stage 0, last_reminded_at null) restarts the ladder", () => {
    const a = ask({ deadline_at: at(28, 15), reminder_stage: 0, last_reminded_at: null });
    expect(next(a)).toBe(at(28, 9));
  });
});

describe("daily cap", () => {
  const many = (n: number, over: Partial<AskRow> = {}) =>
    Array.from({ length: n }, (_, i) => ask({ id: `a${i}`, deadline_at: at(19, 12) - (i % 2) * 0, created_at: 100 + i, ...over }));

  it("reminds the most overdue first and holds back the rest", () => {
    const asks = [
      ask({ id: "new", deadline_at: at(19, 12), created_at: 3 }),
      ask({ id: "old", deadline_at: at(14, 12), created_at: 1 }),
      ask({ id: "mid", deadline_at: at(16, 12), created_at: 2 }),
    ];
    const r = selectDue(asks, prefs({ max_reminders_per_day: 2 }), at(19, 10));
    expect(r.due.map((a) => a.id)).toEqual(["old", "mid"]);
    expect(r.heldBack).toBe(1);
  });

  it("ties break by age", () => {
    const r = selectDue(many(3), prefs({ max_reminders_per_day: 2 }), at(19, 10));
    expect(r.due.map((a) => a.id)).toEqual(["a0", "a1"]);
  });

  it("counts asks already reminded today", () => {
    const p = prefs({ max_reminders_per_day: 5, reminders_day: "2026-10-19", reminders_sent: 4 });
    const r = selectDue(many(3), p, at(19, 10));
    expect(r.due).toHaveLength(1);
    expect(r.heldBack).toBe(2);
  });

  it("resets when the local day changes", () => {
    const p = prefs({ max_reminders_per_day: 2, reminders_day: "2026-10-18", reminders_sent: 2 });
    expect(selectDue(many(3), p, at(19, 10)).due).toHaveLength(2);
  });

  it("uses the local day, not UTC", () => {
    const p = prefs({ tz: NY, max_reminders_per_day: 1, reminders_day: "2026-10-19", reminders_sent: 1 });
    // 2026-10-20 02:00 UTC is still Oct 19 in New York, so the cap is spent (and it is outside hours anyway).
    expect(selectDue(many(1, { deadline_at: at(19, 12, 0, NY) }), p, at(19, 11, 0, NY)).due).toHaveLength(0);
  });

  it("next run skips to tomorrow when today's cap is spent", () => {
    const p = prefs({ reminders_day: "2026-10-19", reminders_sent: 5 });
    const now = at(19, 10);
    expect(nextReminderRun(many(2), p, now)).toBe(at(20, 9));
  });

  it("next run is null with nothing remindable", () => {
    expect(nextReminderRun([ask({ state: "snoozed" })], prefs(), at(19, 10))).toBeNull();
  });
});

describe("timeline integration", () => {
  const snap = (asks: AskRow[], now: number, p = prefs()): Snapshot => ({
    now, prefs: { ...p, last_digest_at: now }, nextSnoozeWake: null, pendingRequests: [], reminderAsks: asks,
  });

  it("reminders appear as a due job and in nextAlarmAt", () => {
    const now = at(19, 10);
    expect(computeDue(snap([ask({ deadline_at: at(19, 12) })], now))).toContainEqual({ kind: "reminders" });
    const future = snap([ask({ deadline_at: at(22, 12) })], now);
    expect(computeDue(future)).toHaveLength(0);
    expect(nextAlarmAt(future)).toBe(Math.min(at(22, 9), nextAlarmAt(snap([], now))!));
  });

  it("digest shows held-back reminders", () => {
    const d = buildDigest(ME, [ask({})], 3)!;
    expect(JSON.stringify(d.blocks)).toContain("Reminders held back today: 3");
    expect(JSON.stringify(buildDigest(ME, [ask({})])!.blocks)).not.toContain("held back");
  });
});
