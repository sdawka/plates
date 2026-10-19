import { describe, expect, it } from "vitest";
import { buildDigest } from "../src/keeper/digest";
import { computeDue, nextAlarmAt, nextDigestAt, type Snapshot } from "../src/keeper/schedule";
import { defaultPrefs } from "../src/domain/repo";
import type { AskRow, RequestRow } from "../src/types";

const ME = "UME";

function ask(over: Partial<AskRow>): AskRow {
  return {
    id: "a", request_id: "r", requester_id: "UDANA", owner_id: ME, holder_id: ME, title: "Q3 numbers",
    detail: null, type: "deliverable", state: "proposed", snoozed_from: null, size: "hours",
    size_source: "llm", urgency: "normal", urgency_source: "llm", estimate_reason: null,
    inferred_due_at: null, deadline_at: null, deadline_change_count: 0, snoozed_until: null,
    snooze_count: 0, round_count: 0, source_ts: null, source_permalink: null, next_step: null,
    done_link: null, last_note: null, created_at: 1, accepted_at: null, closed_at: null, updated_at: 1,
    ...over,
  };
}

const blockText = (d: NonNullable<ReturnType<typeof buildDigest>>) => JSON.stringify(d.blocks);

describe("buildDigest", () => {
  it("returns null when both sections are empty", () => {
    expect(buildDigest(ME, [])).toBeNull();
    expect(buildDigest(ME, [ask({ holder_id: "UOTHER" })])).toBeNull();
  });

  it("splits sections by state, oldest first", () => {
    const d = buildDigest(ME, [
      ask({ id: "2", title: "Newer", created_at: 20 }),
      ask({ id: "1", title: "Older", created_at: 10 }),
      ask({ id: "3", title: "Working", state: "in_progress" }),
    ])!;
    const text = blockText(d);
    expect(text).toContain("Needs your response (2)");
    expect(text).toContain("On my plate (1)");
    expect(text.indexOf("Older")).toBeLessThan(text.indexOf("Newer"));
    expect(text).toContain("Open Plates' Home tab to manage these");
  });

  it("puts requester-plate states under needs response with the owner as counterparty", () => {
    const d = buildDigest(ME, [
      ask({ state: "delivered", requester_id: ME, owner_id: "UBOB", holder_id: ME }),
    ])!;
    const text = blockText(d);
    expect(text).toContain("Needs your response (1)");
    expect(text).toContain("<@UBOB> ×1");
    expect(text).not.toContain("On my plate");
  });

  it("marks snoozed asks with wake time and count, and counts per requester", () => {
    const d = buildDigest(ME, [
      ask({ id: "1", state: "snoozed", snoozed_until: Date.parse("2026-10-20T13:00:00Z"), snooze_count: 2 }),
      ask({ id: "2", state: "accepted" }),
      ask({ id: "3", state: "accepted", requester_id: "UCAROL" }),
    ])!;
    const text = blockText(d);
    expect(text).toContain("💤");
    expect(text).toContain("×2");
    expect(text).toContain("<@UDANA> ×2");
    expect(text).toContain("<@UCAROL> ×1");
  });

  it("truncates long sections", () => {
    const many = Array.from({ length: 20 }, (_, i) => ask({ id: String(i), created_at: i }));
    expect(blockText(buildDigest(ME, many)!)).toContain("and 5 more");
  });
});

describe("schedule", () => {
  const tz = "America/New_York";
  const prefs = { ...defaultPrefs(ME), tz, updated_at: 1 };
  const iso = (s: string) => Date.parse(s);
  const req = (over: Partial<RequestRow>): RequestRow => ({
    id: "r1", channel_id: "C", thread_ts: "1", message_ts: "1", status: "pending_confirmation",
    tagged_by_id: "UT", tag_message_ts: null, requester_id: "UDANA", owner_id: ME, attribution_confidence: 1,
    attribution_reason: null, clarify_question: null, draft_json: "[]", confirmed_by: null,
    confirmed_via: null, nudged_at: null, created_at: iso("2026-10-19T15:00:00Z"), updated_at: 0, ...over,
  });
  const snap = (over: Partial<Snapshot>): Snapshot => ({
    now: iso("2026-10-19T16:00:00Z"), prefs, nextSnoozeWake: null, pendingRequests: [], ...over,
  });

  it("digest is due once per local working day", () => {
    const now = iso("2026-10-19T14:00:00Z"); // Mon 10:00 NY, past 09:00
    expect(nextDigestAt(now, prefs)).toBe(iso("2026-10-19T13:00:00Z")); // overdue, unsent
    const sent = { ...prefs, last_digest_at: iso("2026-10-19T13:00:05Z") };
    expect(nextDigestAt(now, sent)).toBe(iso("2026-10-20T13:00:00Z"));
  });

  it("digest skips the weekend", () => {
    const now = iso("2026-10-16T20:00:00Z"); // Fri afternoon, already sent
    const sent = { ...prefs, last_digest_at: iso("2026-10-16T13:00:00Z") };
    expect(nextDigestAt(now, sent)).toBe(iso("2026-10-19T13:00:00Z"));
    expect(nextDigestAt(iso("2026-10-17T15:00:00Z"), prefs)).toBe(iso("2026-10-19T13:00:00Z"));
  });

  it("flags due wake, nudge and discard jobs", () => {
    const sent = { ...prefs, last_digest_at: iso("2026-10-19T13:00:00Z") };
    const wake = snap({ prefs: sent, nextSnoozeWake: iso("2026-10-19T15:00:00Z") });
    expect(computeDue(wake)).toEqual([{ kind: "wake" }]);

    const early = snap({ prefs: sent, pendingRequests: [req({})] });
    expect(computeDue(early)).toEqual([]);
    expect(nextAlarmAt(early)).toBe(iso("2026-10-20T13:00:00Z")); // nudge and next digest coincide

    const nudgeDue = { ...early, now: iso("2026-10-20T13:00:01Z") };
    expect(computeDue(nudgeDue)).toContainEqual({ kind: "nudge", requestId: "r1" });

    const nudged = req({ nudged_at: iso("2026-10-20T13:00:01Z") });
    const discardDue = snap({ prefs: sent, pendingRequests: [nudged], now: iso("2026-10-21T13:00:01Z") });
    expect(computeDue(discardDue)).toContainEqual({ kind: "discard", requestId: "r1" });
  });
});
