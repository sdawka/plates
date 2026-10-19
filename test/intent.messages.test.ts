import { describe, expect, it } from "vitest";
import { appliedMessage, describeResult, dismissedMessage, expiredMessage, proposalMessage, undoneMessage } from "../src/intent/messages";
import { PROPOSAL_ACTIONS, UNDO_ACTION_ID } from "../src/slack/actions";
import type { Block } from "../src/slack/blocks";
import type { AskRow } from "../src/types";

const ask = (over: Partial<AskRow> = {}): AskRow =>
  ({
    id: "a1", request_id: "r1", requester_id: "UREQ", owner_id: "UOWN", holder_id: "UOWN", title: "Q3 numbers", state: "proposed",
    ...over,
  }) as AskRow;

const json = (v: unknown) => JSON.stringify(v);
const actionElements = (blocks: Block[]) => (blocks.find((b) => b.type === "actions")?.elements ?? []) as Record<string, unknown>[];

describe("appliedMessage", () => {
  it("says who did what and carries an Undo button with the event id", () => {
    const m = appliedMessage("UOWN", { kind: "reject", reason: "marketing owns it" }, ask({ state: "rejected" }), "evt-1");
    expect(m.text).toBe("✓ <@UOWN> → Q3 numbers: rejected: marketing owns it");
    expect(json(m.blocks)).toContain("✓ <@UOWN> → *Q3 numbers*: rejected: marketing owns it");
    expect(actionElements(m.blocks)).toEqual([
      expect.objectContaining({ type: "button", action_id: UNDO_ACTION_ID, value: "evt-1", text: expect.objectContaining({ text: "Undo" }) }),
    ]);
  });
  it("escapes titles and notes", () => {
    const m = appliedMessage("UOWN", { kind: "send_back", question: "a <b> & c" }, ask({ title: "R&D <plan>", holder_id: "UREQ" }), "e");
    expect(json(m.blocks)).toContain("R&amp;D &lt;plan&gt;");
    expect(json(m.blocks)).toContain("a &lt;b&gt; &amp; c");
  });
  it("describes each action", () => {
    const a = ask({ holder_id: "UREQ" });
    expect(describeResult({ kind: "done", link: "https://x.test/d" }, a)).toBe("marked done, now with <@UREQ> to close (<https://x.test/d|result>)");
    expect(describeResult({ kind: "accept_later", deadlineAt: null }, a)).toBe("accepted, no date yet");
    expect(describeResult({ kind: "redirect", toUserId: "UC" }, a)).toBe("redirected to <@UC>");
    expect(describeResult({ kind: "put_back", note: "n" }, ask())).toBe("put back on <@UOWN>'s plate");
    expect(describeResult({ kind: "close" }, a)).toBe("closed");
    expect(describeResult({ kind: "set_deadline", deadlineAt: Date.UTC(2026, 9, 26) }, a)).toContain("<!date^");
  });
  it("undone / dismissed / expired lines", () => {
    expect(undoneMessage().text).toBe("↩︎ Undone");
    expect(dismissedMessage().text).toBe("Okay, ignored.");
    expect(expiredMessage().text).toMatch(/expired/);
  });
});

describe("proposalMessage", () => {
  const base = { id: "p1", source: "reply" as const, actor: "UOWN", options: [{ id: "a1", title: "Q3 numbers" }, { id: "a2", title: "Intro" }] };

  it("asks 'Did you mean' for a known ask with Yes and No", () => {
    const m = proposalMessage({ ...base, action: { kind: "reject", reason: "not mine" }, ask: ask(), picker: false });
    expect(m.text).toBe("<@UOWN> Did you mean: Reject Q3 numbers?");
    expect(json(m.blocks)).toContain("Did you mean: Reject *Q3 numbers*?");
    expect(json(m.blocks)).toContain("not mine");
    const els = actionElements(m.blocks);
    expect(els.map((e) => [e.action_id, e.value])).toEqual([[PROPOSAL_ACTIONS.yes, "p1"], [PROPOSAL_ACTIONS.no, "p1"]]);
  });
  it("adds a Pick ask menu listing the asks when none is chosen", () => {
    const m = proposalMessage({ ...base, action: { kind: "reject" }, ask: null, picker: true });
    const select = actionElements(m.blocks).find((e) => e.type === "static_select")!;
    expect(select.action_id).toBe(PROPOSAL_ACTIONS.pick);
    expect((select.options as { value: string }[]).map((o) => o.value)).toEqual(["p1|a1", "p1|a2"]);
    expect(select.initial_option).toBeUndefined();
    expect(json(m.blocks)).toContain("one of these asks");
  });
  it("preselects the picked ask", () => {
    const m = proposalMessage({ ...base, action: { kind: "reject" }, ask: ask({ id: "a2", title: "Intro" }), picker: true });
    const select = actionElements(m.blocks).find((e) => e.type === "static_select")!;
    expect(select.initial_option).toMatchObject({ value: "p1|a2" });
  });
  it("the detector proposal reads 'looks done?'", () => {
    const m = proposalMessage({ ...base, source: "detector", action: { kind: "done", link: "https://x.test/d" }, ask: ask(), picker: false });
    expect(json(m.blocks)).toContain("Looks like this delivers *Q3 numbers* — mark it done?");
    expect(json(m.blocks)).toContain("https://x.test/d");
    expect(actionElements(m.blocks)[0]).toMatchObject({ text: { text: "Yes, mark done" } });
  });
  it("keeps option values within Slack's 75 character limit for uuid ids", () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    const m = proposalMessage({ ...base, id, action: { kind: "reject" }, ask: null, picker: true, options: [{ id, title: "x".repeat(200) }] });
    const select = actionElements(m.blocks).find((e) => e.type === "static_select")!;
    const [o] = select.options as { value: string; text: { text: string } }[];
    expect(o!.value.length).toBeLessThanOrEqual(75);
    expect(o!.text.text.length).toBeLessThanOrEqual(75);
  });
});
