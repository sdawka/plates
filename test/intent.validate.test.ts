import { describe, expect, it } from "vitest";
import { buildCandidates, detectDelivery, validateDecision, type ValidateInput } from "../src/intent/validate";
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

function input(speaker: string, asks: AskRow[], raw: unknown, over: Partial<ValidateInput> = {}): ValidateInput {
  return { raw, candidates: buildCandidates(asks, speaker), speaker, text: "", tz: "UTC", now: NOW, links: [], files: [], ...over };
}

const one = [ask({ id: "a1" })];
const two = [ask({ id: "a1" }), ask({ id: "a2" })];
const dec = (o: Record<string, unknown>) => ({ action: "none", ask_id: null, note: null, deadline: null, confidence: 0.9, delivers_ask_id: null, ...o });

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

describe("validateDecision", () => {
  it("applies automatically when confident with a single candidate", () => {
    const r = validateDecision(input("UOWN", one, dec({ action: "reject", ask_id: "A1", note: "marketing owns it", confidence: 0.92 })));
    expect(r).toMatchObject({ kind: "act", auto: true, askId: "a1", action: { kind: "reject", reason: "marketing owns it" } });
  });
  it("proposes below the confidence threshold", () => {
    const r = validateDecision(input("UOWN", one, dec({ action: "accept_now", ask_id: "A1", confidence: 0.79 })));
    expect(r).toMatchObject({ kind: "act", auto: false, askId: "a1" });
  });
  it("accepts the real ask id as well as the ref", () => {
    expect(validateDecision(input("UOWN", one, dec({ action: "accept_now", ask_id: "a1" })))).toMatchObject({ askId: "a1" });
  });
  it("does not auto-apply when several asks fit; asks to pick when none is named", () => {
    const r = validateDecision(input("UOWN", two, dec({ action: "reject", ask_id: null, confidence: 0.95 })));
    expect(r).toMatchObject({ kind: "act", auto: false, askId: null });
    expect(r.kind === "act" && r.eligible.map((c) => c.ask.id)).toEqual(["a1", "a2"]);
    const named = validateDecision(input("UOWN", two, dec({ action: "reject", ask_id: "A2", confidence: 0.95 })));
    expect(named).toMatchObject({ auto: false, askId: "a2" });
  });
  it("treats an unknown ask_id as unspecified", () => {
    expect(validateDecision(input("UOWN", one, dec({ action: "accept_now", ask_id: "A9" })))).toMatchObject({ auto: true, askId: "a1" });
  });
  it("rejects actions the speaker may not take", () => {
    expect(validateDecision(input("UOWN", one, dec({ action: "close" })))).toEqual({ kind: "none" }); // owner can't close
    expect(validateDecision(input("UREQ", one, dec({ action: "reject" })))).toEqual({ kind: "none" }); // requester can't reject
    const delivered = [ask({ id: "a1", state: "delivered", holder_id: "UREQ" })];
    expect(validateDecision(input("UREQ", delivered, dec({ action: "close" })))).toMatchObject({ kind: "act", auto: true });
    expect(validateDecision(input("UOWN", delivered, dec({ action: "done" })))).toEqual({ kind: "none" });
  });
  it("never retargets when the named ask doesn't allow the action", () => {
    const asks = [ask({ id: "a1" }), ask({ id: "a2", state: "in_progress" })];
    // accept_now is not available for the in-progress ask A2
    expect(validateDecision(input("UOWN", asks, dec({ action: "accept_now", ask_id: "A2" })))).toEqual({ kind: "none" });
  });
  it("ignores none, unknown actions and garbage", () => {
    expect(validateDecision(input("UOWN", one, dec({ action: "none" })))).toEqual({ kind: "none" });
    expect(validateDecision(input("UOWN", one, dec({ action: "snooze" })))).toEqual({ kind: "none" });
    expect(validateDecision(input("UOWN", one, null))).toEqual({ kind: "none" });
    expect(validateDecision(input("UOWN", one, "x"))).toEqual({ kind: "none" });
  });
  it("clamps confidence and treats a missing one as zero", () => {
    expect(validateDecision(input("UOWN", one, dec({ action: "accept_now", confidence: 7 })))).toMatchObject({ confidence: 1, auto: true });
    expect(validateDecision(input("UOWN", one, dec({ action: "accept_now", confidence: undefined })))).toMatchObject({ confidence: 0, auto: false });
  });

  describe("required values", () => {
    const owner = (o: Record<string, unknown>, over: Partial<ValidateInput> = {}) => validateDecision(input("UOWN", one, dec(o), over));
    it("send_back, ack and put_back need a note", () => {
      expect(owner({ action: "send_back", note: null })).toEqual({ kind: "none" });
      expect(owner({ action: "send_back", note: "need the account id" })).toMatchObject({ action: { kind: "send_back", question: "need the account id" } });
      const ackAsk = [ask({ id: "a1", type: "acknowledge" })];
      expect(validateDecision(input("UOWN", ackAsk, dec({ action: "ack", note: "  " })))).toEqual({ kind: "none" });
      expect(validateDecision(input("UOWN", ackAsk, dec({ action: "ack", note: "sending Thursday" })))).toMatchObject({
        action: { kind: "ack", nextStep: "sending Thursday" },
      });
      const delivered = [ask({ id: "a1", state: "rejected", holder_id: "UREQ" })];
      expect(validateDecision(input("UREQ", delivered, dec({ action: "put_back", note: null })))).toEqual({ kind: "none" });
      expect(validateDecision(input("UREQ", delivered, dec({ action: "put_back", note: "it's yours" })))).toMatchObject({ action: { kind: "put_back", note: "it's yours" } });
    });
    it("redirect needs a mention of someone else", () => {
      expect(owner({ action: "redirect" }, { text: "passing this on" })).toEqual({ kind: "none" });
      expect(owner({ action: "redirect" }, { text: "<@UOWN> me no, ask <@UCAROL|carol>" })).toMatchObject({ action: { kind: "redirect", toUserId: "UCAROL" } });
    });
    it("accept_later parses the deadline in the speaker's tz; no date is allowed", () => {
      const r = owner({ action: "accept_later", deadline: "2026-10-22" }, { tz: "Asia/Tokyo" });
      expect(r).toMatchObject({ action: { kind: "accept_later", deadlineAt: Date.UTC(2026, 9, 22, 14, 59) } });
      expect(owner({ action: "accept_later", deadline: null })).toMatchObject({ action: { kind: "accept_later", deadlineAt: null } });
      expect(owner({ action: "accept_later", deadline: "2026-10-01" })).toMatchObject({ action: { kind: "accept_later", deadlineAt: null } }); // past
      expect(owner({ action: "accept_later", deadline: "tomorrow" })).toMatchObject({ action: { kind: "accept_later", deadlineAt: null } });
    });
    it("set_deadline requires a valid future date", () => {
      const accepted = [ask({ id: "a1", state: "accepted" })];
      const run = (deadline: unknown) => validateDecision(input("UOWN", accepted, dec({ action: "set_deadline", deadline })));
      expect(run(null)).toEqual({ kind: "none" });
      expect(run("2026-10-20")).toEqual({ kind: "none" });
      expect(run("2026-10-26T10:00")).toMatchObject({ action: { kind: "set_deadline", deadlineAt: Date.UTC(2026, 9, 26, 10, 0) } });
    });
    it("done carries the shared link, else the file permalink", () => {
      expect(owner({ action: "done", note: "all there" }, { links: ["https://x.test/doc"] })).toMatchObject({
        action: { kind: "done", link: "https://x.test/doc", note: "all there" },
      });
      expect(owner({ action: "done" }, { files: [{ name: "q3.xlsx", permalink: "https://slack.test/f/1" }] })).toMatchObject({
        action: { kind: "done", link: "https://slack.test/f/1" },
      });
      expect(owner({ action: "done" })).toMatchObject({ action: { kind: "done" } });
    });
  });
});

describe("detectDelivery", () => {
  const shared = { links: ["https://x.test/doc"] };
  it("flags an owner sharing a link for one of their open asks", () => {
    const r = detectDelivery(input("UOWN", two, dec({ action: "none", delivers_ask_id: "A2" }), shared));
    expect(r).toMatchObject({ ask: { id: "a2" }, action: { kind: "done", link: "https://x.test/doc" } });
  });
  it("needs a shared file or link", () => {
    expect(detectDelivery(input("UOWN", two, dec({ delivers_ask_id: "A1" })))).toBeNull();
  });
  it("only for the owner, and only when done is possible", () => {
    expect(detectDelivery(input("UREQ", two, dec({ delivers_ask_id: "A1" }), shared))).toBeNull();
    const ack = [ask({ id: "a1", type: "acknowledge" })]; // acknowledge asks use ack, not done
    expect(detectDelivery(input("UOWN", ack, dec({ delivers_ask_id: "A1" }), shared))).toBeNull();
    expect(detectDelivery(input("UOWN", two, dec({ delivers_ask_id: "zzz" }), shared))).toBeNull();
    expect(detectDelivery(input("UOWN", two, dec({ delivers_ask_id: null }), shared))).toBeNull();
  });
  it("uses the file name as a note when the file has no permalink", () => {
    const r = detectDelivery(input("UOWN", one, dec({ delivers_ask_id: "A1" }), { files: [{ name: "deck.pdf", permalink: null }] }));
    expect(r?.action).toEqual({ kind: "done", note: "deck.pdf" });
  });
});
