import { describe, expect, it } from "vitest";
import { askStatusText, menuActions, renderDm, renderRequest, type DmContext } from "../src/slack/blocks";
import type { AskRow, DraftAsk, RequestRow } from "../src/types";

const draft = (title: string): DraftAsk => ({
  title, detail: null, type: "deliverable", size: "hours", urgency: "high", estimate_reason: "big",
  inferred_due_at: null, owner_already_committed: false, source_ts: "1.1", source_permalink: null,
});

const req = (over: Partial<RequestRow> = {}): RequestRow => ({
  id: "r1", channel_id: "C1", thread_ts: "1.0", message_ts: "1.5", status: "pending_confirmation",
  tagged_by_id: "UTAG", tag_message_ts: null, requester_id: "UDANA", owner_id: "UBOB", attribution_confidence: 0.9,
  attribution_reason: null, clarify_question: null, draft_json: JSON.stringify([draft("Q3 numbers"), draft("Ack <pricing>")]),
  confirmed_by: null, confirmed_via: null, nudged_at: null, created_at: 0, updated_at: 0, ...over,
});

const ask = (over: Partial<AskRow> = {}): AskRow => ({
  id: "a1", request_id: "r1", requester_id: "UDANA", owner_id: "UBOB", holder_id: "UBOB", title: "Q3 numbers",
  detail: null, type: "deliverable", state: "proposed", snoozed_from: null, size: "hours", size_source: "llm",
  urgency: "high", urgency_source: "llm", estimate_reason: null, inferred_due_at: null, deadline_at: null,
  deadline_change_count: 0, snoozed_until: null, snooze_count: 0, round_count: 0, source_ts: null,
  source_permalink: null, next_step: null, done_link: null, last_note: null, created_at: 0, accepted_at: null,
  closed_at: null,
  reminder_stage: 0, last_reminded_at: null, last_bumped_at: null, tracker_ref: null, tracker_url: null, updated_at: 0, ...over,
});

const json = (v: unknown) => JSON.stringify(v);

describe("pending request message", () => {
  it("names requester, owner and tagger, lists items escaped, and has an Edit button", () => {
    const out = renderRequest(req(), []);
    const s = json(out.blocks);
    expect(s).toContain("*<@UDANA>* is asking *<@UBOB>* for 2 things (tagged by <@UTAG>)");
    expect(s).toContain("☐ Q3 numbers · few hours · high");
    expect(s).toContain("Ack &lt;pricing&gt;");
    expect(s).toContain("React ✅ to confirm or ❌ to change");
    expect(s).toContain("req:edit");
  });

  it("omits the tagger when they are the requester, and shows the clarify question", () => {
    const s = json(renderRequest(req({ tagged_by_id: "UDANA", clarify_question: "Who's asking?" }), []).blocks);
    expect(s).not.toContain("tagged by");
    expect(s).toContain("Who's asking?");
  });

  it("says a discarded request was not confirmed", () => {
    expect(json(renderRequest(req({ status: "discarded" }), []).blocks)).toContain("was not confirmed");
  });
});

describe("live request message", () => {
  it("shows a header, one line per ask with a status and a menu", () => {
    const out = renderRequest(req({ status: "confirmed" }), [ask(), ask({ id: "a2", state: "in_progress" })]);
    expect(out.text).toBe("<@UDANA> → <@UBOB> · 2 asks");
    expect(out.blocks).toHaveLength(3);
    const s = json(out.blocks);
    expect(s).toContain("awaiting <@UBOB>");
    expect(s).toContain("in progress");
    expect(s).toContain("ask:overflow");
    expect(s).toContain("ask:accept_later|a1");
  });

  it("describes states in neutral words with counters", () => {
    expect(askStatusText(ask({ state: "delivered" }))).toBe("delivered — waiting on <@UDANA> to close");
    expect(askStatusText(ask({ state: "snoozed", snoozed_until: 1_800_000_000_000, snooze_count: 2 }))).toMatch(/^💤 until <!date\^1800000000\^\{date_short_pretty\}\|2027-01-15> ×2$/);
    expect(askStatusText(ask({ state: "accepted", deadline_at: 1_800_000_000_000, deadline_change_count: 2, round_count: 1 })))
      .toContain("moved ×2 · round 2");
    expect(askStatusText(ask({ state: "in_progress", snooze_count: 1 }))).toBe("in progress · 💤×1");
  });

  it("menu is the union of owner and requester actions, without duplicates, empty when ended", () => {
    const kinds = menuActions(ask());
    expect(kinds).toContain("accept_now");
    expect(kinds).toContain("withdraw");
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(menuActions(ask({ state: "closed" }))).toEqual([]);
  });
});

describe("DMs", () => {
  const ctx = (over: Partial<DmContext> = {}): DmContext => ({
    req: req({ status: "confirmed" }), asks: [ask()], ask: ask(), recipient: "UBOB", permalink: "https://x/p", ...over,
  });

  it("request_proposed gives the owner per-ask buttons and the thread link", () => {
    const out = renderDm("request_proposed", ctx())!;
    const s = json(out.blocks);
    expect(s).toContain("<@UDANA>");
    expect(s).toContain("https://x/p");
    for (const id of ["ask:accept_now", "ask:accept_later", "ask:reject", "ask:send_back", "ask:done"]) expect(s).toContain(id);
    expect(s).not.toContain("ask:close");
  });

  it("ask_delivered gives the requester Close and Put back", () => {
    const delivered = ask({ state: "delivered", holder_id: "UDANA", done_link: "https://doc" });
    const s = json(renderDm("ask_delivered", ctx({ recipient: "UDANA", ask: delivered, note: "here you go" }))!.blocks);
    expect(s).toContain("ask:close");
    expect(s).toContain("ask:put_back");
    expect(s).toContain("https://doc");
  });

  it("ask_clarify relabels Put back as an answer", () => {
    const a = ask({ state: "clarify", holder_id: "UDANA" });
    expect(json(renderDm("ask_clarify", ctx({ recipient: "UDANA", ask: a, note: "which account?" }))!.blocks)).toContain("Put back with answer");
  });

  it("deadline_changed handles moved, first and unknown-previous deadlines", () => {
    const a = ask({ state: "accepted", deadline_at: 1_800_000_000_000 });
    const moved = renderDm("deadline_changed", ctx({ ask: a, deadline: { from: 1_700_000_000_000, to: 1_800_000_000_000 } }))!;
    expect(moved.text).toContain("moved Q3 numbers:");
    expect(renderDm("deadline_changed", ctx({ ask: a, deadline: { from: null, to: 1_800_000_000_000 } }))!.text).toContain("expects Q3 numbers by");
    expect(renderDm("deadline_changed", ctx({ ask: a }))!.text).toContain("expects Q3 numbers by");
  });

  it("confirm_nudge has a confirm button; ask templates without an ask render nothing", () => {
    expect(json(renderDm("confirm_nudge", ctx({ ask: null, req: req() }))!.blocks)).toContain("req:confirm");
    expect(renderDm("ask_rejected", ctx({ ask: null }))).toBeNull();
  });
});
