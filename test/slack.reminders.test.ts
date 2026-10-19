import { describe, expect, it } from "vitest";
import { renderDm, reminderButtons, renderRequest, type Block, type DmContext } from "../src/slack/blocks";
import type { AskRow, RequestRow } from "../src/types";

function ask(over: Partial<AskRow> & { id: string }): AskRow {
  return {
    request_id: "r1", requester_id: "UREQ", owner_id: "UOWN", holder_id: "UOWN", title: `Title ${over.id}`,
    detail: null, type: "deliverable", state: "accepted", snoozed_from: null, size: "hours", size_source: "llm",
    urgency: "high", urgency_source: "llm", estimate_reason: null, inferred_due_at: null, deadline_at: null,
    deadline_change_count: 0, snoozed_until: null, snooze_count: 0, round_count: 0, source_ts: null,
    source_permalink: null, next_step: null, done_link: null, last_note: null, created_at: 1, accepted_at: null,
    closed_at: null, updated_at: 1, reminder_stage: 0, last_reminded_at: null, last_bumped_at: null,
    tracker_ref: null, tracker_url: null, ...over,
  };
}
const req = { id: "r1", channel_id: "C1", thread_ts: "1.1", status: "confirmed", tagged_by_id: "UREQ", requester_id: "UREQ", owner_id: "UOWN" } as RequestRow;
const ctx = (over: Partial<DmContext>): DmContext => ({ req, asks: [], ask: null, recipient: "UOWN", permalink: "https://slack.test/t", ...over });

const buttonIds = (blocks: Block[]) =>
  blocks.filter((b) => b.type === "actions").map((b) => (b.elements as { action_id: string }[]).map((e) => e.action_id));
const labels = (blocks: Block[]) =>
  blocks.filter((b) => b.type === "actions").map((b) => (b.elements as { text: { text: string } }[]).map((e) => e.text.text));
const json = (v: unknown) => JSON.stringify(v);

describe("reminder DM", () => {
  it("lists each ask with requester, size, urgency, deadline and snooze count", () => {
    const asks = [
      ask({ id: "a1", deadline_at: Date.UTC(2026, 9, 22), snooze_count: 1 }),
      ask({ id: "a2", state: "proposed" }),
    ];
    const r = renderDm("reminder", ctx({ reminderAsks: asks }))!;
    const text = json(r.blocks);
    expect(r.text).toBe("Reminder: 2 asks are waiting on you");
    expect(text).toContain("*Title a1*");
    expect(text).toContain("from <@UREQ>");
    expect(text).toContain("few hours · high");
    expect(text).toContain("due <!date^");
    expect(text).toContain("💤×1");
    expect(buttonIds(r.blocks)[0]).toEqual(["ask:accept_now", "ask:done", "ask:set_deadline", "ask:snooze"]);
    expect(buttonIds(r.blocks)[1]).toEqual(["ask:accept_now", "ask:accept_later", "ask:done", "ask:snooze", "ask:reject"]);
  });

  it("after the third snooze puts Set deadline, Redirect, Reject before Snooze anyway", () => {
    const a = ask({ id: "a1", snooze_count: 3 });
    const { kinds, labels: l } = reminderButtons(a, "UOWN");
    expect(kinds).toEqual(["set_deadline", "redirect", "reject", "snooze"]);
    expect(l.snooze).toBe("Snooze anyway");
    const r = renderDm("reminder", ctx({ reminderAsks: [a] }))!;
    expect(labels(r.blocks)[0]).toEqual(["Set deadline", "Redirect", "Reject", "Snooze anyway"]);
    expect(json(r.blocks)).toContain("Snoozed 3 times");
  });

  it("uses accept_later as 'Set deadline' for a proposed ask with 3+ snoozes", () => {
    const { kinds } = reminderButtons(ask({ id: "a1", state: "proposed", snooze_count: 4 }), "UOWN");
    expect(kinds).toEqual(["accept_later", "redirect", "reject", "snooze"]);
  });

  it("gives asks on the requester's plate the requester buttons", () => {
    const delivered = ask({ id: "a1", state: "delivered", holder_id: "UREQ" });
    const r = renderDm("reminder", ctx({ recipient: "UREQ", reminderAsks: [delivered] }))!;
    expect(buttonIds(r.blocks)[0]).toEqual(["ask:close", "ask:put_back", "ask:redirect"]);
    expect(json(r.blocks)).toContain("<@UOWN>");
  });

  it("is null with nothing left, skips ended asks and stays inside the block limit", () => {
    expect(renderDm("reminder", ctx({ reminderAsks: [] }))).toBeNull();
    expect(renderDm("reminder", ctx({ reminderAsks: [ask({ id: "a1", state: "closed" })] }))).toBeNull();
    const many = Array.from({ length: 40 }, (_, i) => ask({ id: `a${i}` }));
    const r = renderDm("reminder", ctx({ reminderAsks: many }))!;
    expect(r.blocks.length).toBeLessThanOrEqual(50);
    expect(json(r.blocks)).toContain("and 25 more");
  });
});

describe("bump DM", () => {
  it("tells the owner who bumped what, with owner buttons", () => {
    const a = ask({ id: "a1", state: "in_progress" });
    const r = renderDm("bump", ctx({ ask: a, asks: [a] }))!;
    expect(r.text).toBe("Title a1: bumped");
    expect(json(r.blocks)).toContain("<@UREQ> bumped *Title a1*");
    expect(json(r.blocks)).toContain("https://slack.test/t");
    expect(buttonIds(r.blocks)[0]).toEqual(["ask:done", "ask:set_deadline", "ask:snooze"]);
  });
  it("needs an ask", () => {
    expect(renderDm("bump", ctx({}))).toBeNull();
  });
});

describe("action_undone DM", () => {
  it("names the actor and the undone action", () => {
    const a = ask({ id: "a1" });
    const r = renderDm("action_undone", ctx({ ask: a, actor: "UOWN", note: "done", recipient: "UREQ" }))!;
    expect(r.text).toBe("<@UOWN> undid Done on Title a1");
    expect(json(r.blocks)).toContain("<@UOWN> undid *Done* on *Title a1*");
  });
  it("falls back gracefully", () => {
    const r = renderDm("action_undone", ctx({ ask: ask({ id: "a1" }) }))!;
    expect(r.text).toBe("Someone undid their last action on Title a1");
  });
});

describe("thread message ask menu", () => {
  it("offers Bump for asks on the owner's plate only", () => {
    const live = { ...req, message_ts: "1.2" } as RequestRow;
    const options = (a: AskRow) => {
      const block = renderRequest(live, [a]).blocks.find((b) => b.block_id === `s:${a.id}`)!;
      return ((block.accessory as { options: { value: string }[] }).options).map((o) => o.value);
    };
    expect(options(ask({ id: "a1", state: "proposed" }))).toContain("askx:bump|a1");
    expect(options(ask({ id: "a2", state: "delivered", holder_id: "UREQ" }))).not.toContain("askx:bump|a2");
  });
});
