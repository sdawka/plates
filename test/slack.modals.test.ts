import { describe, expect, it } from "vitest";
import { buildAskModal, buildEditModal, parseAskSubmission, parseEditSubmission, type ViewValues } from "../src/slack/modals";
import { dateInTz, endOfDay, snoozeUntil, zonedToEpoch } from "../src/slack/times";
import type { AskRow, RequestRow } from "../src/types";

const v = (o: Record<string, Record<string, unknown>>): ViewValues =>
  Object.fromEntries(Object.entries(o).map(([k, x]) => [k, { v: x }])) as ViewValues;
const ctx = { now: Date.UTC(2026, 9, 21, 12, 0), tz: "UTC" }; // Wed 2026-10-21 12:00Z

describe("time helpers", () => {
  it("converts wall-clock time in a zone, including DST", () => {
    expect(zonedToEpoch(2026, 7, 1, 9, 0, "America/New_York")).toBe(Date.UTC(2026, 6, 1, 13, 0));
    expect(zonedToEpoch(2026, 1, 1, 9, 0, "America/New_York")).toBe(Date.UTC(2026, 0, 1, 14, 0));
    expect(zonedToEpoch(2026, 1, 1, 9, 0, "Asia/Kolkata")).toBe(Date.UTC(2026, 0, 1, 3, 30));
  });
  it("end of day and date round trip", () => {
    const at = endOfDay("2026-10-22", "Asia/Tokyo")!;
    expect(at).toBe(Date.UTC(2026, 9, 22, 14, 59));
    expect(dateInTz(at, "Asia/Tokyo")).toBe("2026-10-22");
    expect(endOfDay("nope", "UTC")).toBeNull();
  });
  it("snooze presets", () => {
    expect(snoozeUntil("2h", ctx.now, "UTC")).toBe(ctx.now + 7_200_000);
    expect(snoozeUntil("tomorrow", ctx.now, "UTC")).toBe(Date.UTC(2026, 9, 22, 9, 0));
    expect(snoozeUntil("monday", ctx.now, "UTC")).toBe(Date.UTC(2026, 9, 26, 9, 0));
    // Monday itself rolls to the following Monday
    expect(snoozeUntil("monday", Date.UTC(2026, 9, 26, 8, 0), "UTC")).toBe(Date.UTC(2026, 10, 2, 9, 0));
  });
  it("falls back to UTC on a bad zone", () => {
    expect(snoozeUntil("tomorrow", ctx.now, "Not/AZone")).toBe(Date.UTC(2026, 9, 22, 9, 0));
  });
});

describe("parseAskSubmission", () => {
  it("accept_later: empty date means no date yet; past date is an error", () => {
    expect(parseAskSubmission("accept_later", v({ date: {} }), ctx)).toEqual({ ok: true, value: { kind: "accept_later", deadlineAt: null } });
    expect(parseAskSubmission("accept_later", v({ date: { selected_date: "2026-10-23" } }), ctx)).toEqual({
      ok: true, value: { kind: "accept_later", deadlineAt: Date.UTC(2026, 9, 23, 23, 59) },
    });
    const past = parseAskSubmission("accept_later", v({ date: { selected_date: "2026-10-01" } }), ctx);
    expect(past.ok).toBe(false);
  });

  it("done validates the link; ack and send_back and put_back require text", () => {
    expect(parseAskSubmission("done", v({ link: { value: "not a url" }, note: {} }), ctx).ok).toBe(false);
    expect(parseAskSubmission("done", v({ link: { value: " https://a.b/c " }, note: { value: "" } }), ctx)).toEqual({
      ok: true, value: { kind: "done", link: "https://a.b/c", note: undefined },
    });
    expect(parseAskSubmission("ack", v({ next: { value: "  " } }), ctx).ok).toBe(false);
    expect(parseAskSubmission("send_back", v({ question: { value: "which?" } }), ctx)).toEqual({ ok: true, value: { kind: "send_back", question: "which?" } });
    expect(parseAskSubmission("put_back", v({ note: {} }), ctx).ok).toBe(false);
  });

  it("reject and withdraw treat empty notes as undefined", () => {
    expect(parseAskSubmission("reject", v({ reason: { value: "" } }), ctx)).toEqual({ ok: true, value: { kind: "reject", reason: undefined } });
    expect(parseAskSubmission("withdraw", v({ note: { value: "n" } }), ctx)).toEqual({ ok: true, value: { kind: "withdraw", note: "n" } });
  });

  it("set_deadline can clear the deadline", () => {
    expect(parseAskSubmission("set_deadline", v({ date: { selected_date: null } }), ctx)).toEqual({ ok: true, value: { kind: "set_deadline", deadlineAt: null } });
  });

  it("snooze: presets, custom requires a future time", () => {
    expect(parseAskSubmission("snooze", v({ preset: { selected_option: { value: "2h" } }, custom: {} }), ctx)).toEqual({
      ok: true, value: { kind: "snooze", until: ctx.now + 7_200_000 },
    });
    expect(parseAskSubmission("snooze", v({ preset: { selected_option: { value: "custom" } }, custom: {} }), ctx).ok).toBe(false);
    expect(parseAskSubmission("snooze", v({ preset: { selected_option: { value: "custom" } }, custom: { selected_date_time: ctx.now / 1000 - 5 } }), ctx).ok).toBe(false);
    expect(parseAskSubmission("snooze", v({ preset: { selected_option: { value: "custom" } }, custom: { selected_date_time: ctx.now / 1000 + 5 } }), ctx).ok).toBe(true);
    expect(parseAskSubmission("snooze", v({ preset: {} }), ctx).ok).toBe(false);
  });

  it("set_estimate and redirect", () => {
    expect(parseAskSubmission("set_estimate", v({ size: { selected_option: { value: "days" } }, urgency: { selected_option: { value: "urgent" } } }), ctx)).toEqual({
      ok: true, value: { kind: "set_estimate", size: "days", urgency: "urgent" },
    });
    expect(parseAskSubmission("set_estimate", v({ size: { selected_option: { value: "huge" } }, urgency: {} }), ctx).ok).toBe(false);
    expect(parseAskSubmission("redirect", v({ user: { selected_user: "UCAROL" }, note: {} }), ctx)).toEqual({
      ok: true, value: { kind: "redirect", toUserId: "UCAROL", note: undefined },
    });
    expect(parseAskSubmission("redirect", v({ user: {} }), ctx).ok).toBe(false);
  });
});

const ask = { id: "a1", title: "Q3 <numbers>", requester_id: "UD", size: "hours", urgency: "high", deadline_at: null } as AskRow;

describe("modal builders", () => {
  it("every modal-needing kind builds a view with matching callback id and metadata", () => {
    const kinds = ["accept_later", "done", "ack", "reject", "send_back", "set_deadline", "snooze", "set_estimate", "redirect", "put_back", "withdraw"] as const;
    for (const kind of kinds) {
      const view = buildAskModal(kind, ask, { askId: "a1", via: "home" }, "UTC") as { callback_id: string; private_metadata: string; blocks: unknown[]; title: { text: string } };
      expect(view.callback_id).toBe(`modal:${kind}`);
      expect(JSON.parse(view.private_metadata)).toEqual({ askId: "a1", via: "home" });
      expect(view.title.text.length).toBeLessThanOrEqual(24);
      expect(view.blocks.length).toBeGreaterThan(1);
    }
  });
});

describe("edit modal", () => {
  const draft = (title: string) => ({ title });
  const req = { id: "r1", requester_id: "UD", owner_id: "UB", draft_json: JSON.stringify([draft("a"), draft("b"), draft("c")]) } as RequestRow;

  it("builds user selects and a checkbox per item", () => {
    expect(JSON.stringify(buildEditModal(req))).toContain('"initial_user":"UD"');
  });

  it("keeps checked items and applies new people", () => {
    const r = parseEditSubmission(v({ requester: { selected_user: "UC" }, owner: { selected_user: "UB" }, items: { selected_options: [{ value: "0" }, { value: "2" }] } }), req);
    expect(r.ok && r.value.requester_id).toBe("UC");
    expect(r.ok && JSON.parse(r.value.draft_json)).toEqual([draft("a"), draft("c")]);
  });

  it("rejects same person, and unchecking everything", () => {
    expect(parseEditSubmission(v({ requester: { selected_user: "UB" }, owner: { selected_user: "UB" }, items: { selected_options: [{ value: "0" }] } }), req).ok).toBe(false);
    expect(parseEditSubmission(v({ requester: { selected_user: "UC" }, owner: { selected_user: "UB" }, items: { selected_options: [] } }), req).ok).toBe(false);
  });
});
