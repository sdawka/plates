import { describe, expect, it } from "vitest";
import { buildCandidates, detectDelivery, parseChoice, validateDecision, type IntentDecision, type ValidateInput } from "../src/intent/validate";
import type { AskRow } from "../src/types";

const NOW = Date.UTC(2026, 9, 21, 12, 0); // Wed 2026-10-21

function ask(over: Partial<AskRow> & { id: string }): AskRow {
  return {
    request_id: "r1", requester_id: "UREQ", owner_id: "UOWN", holder_id: "UOWN", title: `Title ${over.id}`,
    detail: null, type: "deliverable", state: "proposed", snoozed_from: null, size: "lt1h", size_source: "llm",
    urgency: "normal", urgency_source: "llm", estimate_reason: null, inferred_due_at: null, deadline_at: null,
    deadline_change_count: 0, snoozed_until: null, snooze_count: 0, round_count: 0, source_ts: null,
    source_permalink: null, next_step: null, done_link: null, last_note: null, created_at: 1, accepted_at: null,
    closed_at: null, updated_at: 1, reminder_stage: 0, last_reminded_at: null, last_bumped_at: null,
    tracker_ref: null, tracker_url: null, ...over,
  };
}

const NONE: IntentDecision = { choice: "none", p: 0.95, ambiguous: 0, deadline: null, delivers: {} };
const dec = (o: Partial<IntentDecision> = {}): IntentDecision => ({ ...NONE, ...o });

function input(speaker: string, asks: AskRow[], decision: IntentDecision, over: Partial<ValidateInput> = {}): ValidateInput {
  return { decision, candidates: buildCandidates(asks, speaker), speaker, text: "", tz: "UTC", now: NOW, links: [], files: [], ...over };
}

const one = [ask({ id: "a1" })];
const two = [ask({ id: "a1" }), ask({ id: "a2" })];

describe("buildCandidates", () => {
  it("lists only open asks the speaker is a party to, with their allowed actions", () => {
    const asks = [ask({ id: "a1" }), ask({ id: "a2", state: "closed" }), ask({ id: "a3", owner_id: "UX", requester_id: "UY" })];
    const owner = buildCandidates(asks, "UOWN");
    expect(owner.map((c) => c.ask.id)).toEqual(["a1"]);
    expect(owner[0]!.allowed).toContain("reject");
    expect(owner[0]!.allowed).not.toContain("close");
    expect(owner[0]!.allowed).not.toContain("snooze"); // not an intent kind
    expect(buildCandidates(asks, "UREQ")[0]!.allowed).toEqual(["redirect", "withdraw"]);
  });
});

describe("parseChoice", () => {
  const candidates = buildCandidates(two, "UOWN");
  it("splits '<ref>:<action>' into its candidate and action", () => {
    expect(parseChoice(candidates, "A2:reject")).toMatchObject({ candidate: { ask: { id: "a2" } }, kind: "reject" });
  });
  it("rejects none, unknown refs, unknown actions and actions the speaker may not take", () => {
    for (const choice of ["none", "A9:reject", "A1:snooze", "A1:close", "reject", ""]) expect(parseChoice(candidates, choice), choice).toBeNull();
  });
});

describe("validateDecision", () => {
  it("applies automatically at p >= 0.85 with no ambiguity", () => {
    const r = validateDecision(input("UOWN", one, dec({ choice: "A1:reject", p: 0.92 }), { text: "marketing owns it" }));
    expect(r).toMatchObject({ kind: "act", auto: true, askId: "a1", confidence: 0.92, action: { kind: "reject", reason: "marketing owns it" } });
    expect(validateDecision(input("UOWN", one, dec({ choice: "A1:accept_now", p: 0.85 })))).toMatchObject({ auto: true });
  });
  it("proposes from 0.5 up to the auto threshold", () => {
    expect(validateDecision(input("UOWN", one, dec({ choice: "A1:accept_now", p: 0.84 })))).toMatchObject({ kind: "act", auto: false, askId: "a1" });
    expect(validateDecision(input("UOWN", one, dec({ choice: "A1:accept_now", p: 0.5 })))).toMatchObject({ kind: "act", auto: false });
  });
  it("does nothing below 0.5, and for none", () => {
    expect(validateDecision(input("UOWN", one, dec({ choice: "A1:accept_now", p: 0.49 })))).toEqual({ kind: "none" });
    expect(validateDecision(input("UOWN", one, dec({ choice: "none", p: 0.99 })))).toEqual({ kind: "none" });
  });
  it("the ambiguous gate turns an auto-apply into a pick among the asks the action fits", () => {
    const sure = validateDecision(input("UOWN", two, dec({ choice: "A2:reject", p: 0.97, ambiguous: 0.19 })));
    expect(sure).toMatchObject({ auto: true, askId: "a2" });
    const unsure = validateDecision(input("UOWN", two, dec({ choice: "A2:reject", p: 0.97, ambiguous: 0.2 })));
    expect(unsure).toMatchObject({ kind: "act", auto: false, askId: null });
    expect(unsure.kind === "act" && unsure.eligible.map((c) => c.ask.id)).toEqual(["a1", "a2"]);
  });
  it("a named ask that doesn't allow the action is never retargeted", () => {
    const asks = [ask({ id: "a1" }), ask({ id: "a2", state: "in_progress" })];
    expect(validateDecision(input("UOWN", asks, dec({ choice: "A2:accept_now" })))).toEqual({ kind: "none" }); // not available in progress
    expect(validateDecision(input("UOWN", asks, dec({ choice: "A1:accept_now" })))).toMatchObject({ askId: "a1" });
  });
  it("rejects actions the speaker may not take", () => {
    expect(validateDecision(input("UOWN", one, dec({ choice: "A1:close" })))).toEqual({ kind: "none" });
    expect(validateDecision(input("UREQ", one, dec({ choice: "A1:reject" })))).toEqual({ kind: "none" });
    const delivered = [ask({ id: "a1", state: "delivered", holder_id: "UREQ" })];
    expect(validateDecision(input("UREQ", delivered, dec({ choice: "A1:close" })))).toMatchObject({ kind: "act", auto: true });
  });

  describe("required values", () => {
    const owner = (o: Partial<IntentDecision>, over: Partial<ValidateInput> = {}) => validateDecision(input("UOWN", one, dec(o), over));
    it("send_back, ack and put_back take the reply as their note and need one", () => {
      expect(owner({ choice: "A1:send_back" }, { text: " " })).toEqual({ kind: "none" });
      expect(owner({ choice: "A1:send_back" }, { text: "need the account id" })).toMatchObject({ action: { kind: "send_back", question: "need the account id" } });
      const ackAsk = [ask({ id: "a1", type: "acknowledge" })];
      expect(validateDecision(input("UOWN", ackAsk, dec({ choice: "A1:ack" }), { text: "  " }))).toEqual({ kind: "none" });
      expect(validateDecision(input("UOWN", ackAsk, dec({ choice: "A1:ack" }), { text: "sending Thursday" }))).toMatchObject({ action: { kind: "ack", nextStep: "sending Thursday" } });
      const rejected = [ask({ id: "a1", state: "rejected", holder_id: "UREQ" })];
      expect(validateDecision(input("UREQ", rejected, dec({ choice: "A1:put_back" }), { text: "it's yours" }))).toMatchObject({ action: { kind: "put_back", note: "it's yours" } });
    });
    it("the note is trimmed and capped at 500 characters", () => {
      const r = owner({ choice: "A1:reject" }, { text: `  ${"x".repeat(600)}  ` });
      expect(r.kind === "act" && r.action.kind === "reject" && r.action.reason).toHaveLength(500);
    });
    it("redirect targets the first mention that is neither the speaker nor the bot; none means no action", () => {
      expect(owner({ choice: "A1:redirect" }, { text: "passing this on" })).toEqual({ kind: "none" });
      expect(owner({ choice: "A1:redirect" }, { text: "<@UOWN> me no, ask <@UCAROL|carol>" })).toMatchObject({ action: { kind: "redirect", toUserId: "UCAROL" } });
      expect(owner({ choice: "A1:redirect" }, { text: "<@UBOT> hand to <@UCAROL>", botUserId: "UBOT" })).toMatchObject({ action: { toUserId: "UCAROL" } });
      expect(owner({ choice: "A1:redirect" }, { text: "<@UBOT> please", botUserId: "UBOT" })).toEqual({ kind: "none" });
    });
    it("accept_later parses the deadline in the speaker's tz; no date is allowed", () => {
      const r = owner({ choice: "A1:accept_later", deadline: "2026-10-22" }, { tz: "Asia/Tokyo" });
      expect(r).toMatchObject({ action: { kind: "accept_later", deadlineAt: Date.UTC(2026, 9, 22, 14, 59) } });
      expect(owner({ choice: "A1:accept_later", deadline: null })).toMatchObject({ action: { kind: "accept_later", deadlineAt: null } });
      expect(owner({ choice: "A1:accept_later", deadline: "2026-10-01" })).toMatchObject({ action: { kind: "accept_later", deadlineAt: null } }); // past
    });
    it("set_deadline requires a future date", () => {
      const accepted = [ask({ id: "a1", state: "accepted" })];
      const run = (deadline: string | null) => validateDecision(input("UOWN", accepted, dec({ choice: "A1:set_deadline", deadline })));
      expect(run(null)).toEqual({ kind: "none" });
      expect(run("2026-10-20")).toEqual({ kind: "none" });
      expect(run("2026-10-26")).toMatchObject({ action: { kind: "set_deadline", deadlineAt: Date.UTC(2026, 9, 26, 23, 59) } });
    });
    it("done carries the shared link, else the file permalink, and the reply as its note", () => {
      expect(owner({ choice: "A1:done" }, { text: "all there", links: ["https://x.test/doc"] })).toMatchObject({
        action: { kind: "done", link: "https://x.test/doc", note: "all there" },
      });
      expect(owner({ choice: "A1:done" }, { files: [{ name: "q3.xlsx", permalink: "https://slack.test/f/1" }] })).toMatchObject({
        action: { kind: "done", link: "https://slack.test/f/1" },
      });
    });
  });
});

describe("detectDelivery", () => {
  const shared = { links: ["https://x.test/doc"] };
  const delivers = (o: Record<string, number>) => dec({ delivers: o });
  it("flags an owner sharing a link for the open ask it most likely delivers", () => {
    const r = detectDelivery(input("UOWN", two, delivers({ A1: 0.62, A2: 0.9 }), shared));
    expect(r).toMatchObject({ ask: { id: "a2" }, action: { kind: "done", link: "https://x.test/doc" } });
  });
  it("needs p >= 0.6 and a shared file or link", () => {
    expect(detectDelivery(input("UOWN", two, delivers({ A1: 0.59 }), shared))).toBeNull();
    expect(detectDelivery(input("UOWN", two, delivers({ A1: 0.99 })))).toBeNull();
  });
  it("only for the owner, and only when done is possible", () => {
    expect(detectDelivery(input("UREQ", two, delivers({ A1: 0.99 }), shared))).toBeNull();
    const ack = [ask({ id: "a1", type: "acknowledge" })]; // acknowledge asks use ack, not done
    expect(detectDelivery(input("UOWN", ack, delivers({ A1: 0.99 }), shared))).toBeNull();
    expect(detectDelivery(input("UOWN", two, delivers({ A9: 0.99 }), shared))).toBeNull();
  });
  it("uses the file name as a note when the file has no permalink", () => {
    const r = detectDelivery(input("UOWN", one, delivers({ A1: 0.9 }), { files: [{ name: "deck.pdf", permalink: null }] }));
    expect(r?.action).toEqual({ kind: "done", note: "deck.pdf" });
  });
});
