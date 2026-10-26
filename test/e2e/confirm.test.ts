import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHANNEL, USERS, createHarness, extractionInput, type Harness } from "../helpers/env";
import { tagThread, text } from "../helpers/scenario";

let h: Harness;
beforeEach(() => void (h = createHarness()));
afterEach(() => h.dispose());

const threadReplies = (root: string) => h.slack.posts({ thread_ts: root }).map((c) => String(c.args.text));

describe("confirming with reactions", () => {
  it("a check from the requester confirms: live message, owner DM with buttons, asks created", async () => {
    const t = await tagThread(h, { titles: ["Send the Q3 numbers", "Ping finance"] });
    await h.react(USERS.dana, { channel: CHANNEL, ts: t.card.ts }, "white_check_mark");

    expect(h.requests()[0]).toMatchObject({ status: "confirmed", confirmed_by: USERS.dana, confirmed_via: "reaction" });
    expect(h.asks().map((a) => [a.title, a.state, a.holder_id])).toEqual([
      ["Send the Q3 numbers", "proposed", USERS.bob],
      ["Ping finance", "proposed", USERS.bob],
    ]);

    // The same message is updated in place into the live request.
    const update = h.slack.callsTo("chat.update").at(-1)!;
    expect(update.args).toMatchObject({ channel: CHANNEL, ts: t.card.ts });
    const live = text(h.slack.message(CHANNEL, t.card.ts));
    expect(live).toContain(`<@${USERS.dana}> → <@${USERS.bob}> · 2 asks`);
    expect(live).toContain("awaiting <@UBOB>");

    // Owner DM: one section per ask with the owner buttons.
    const dm = h.slack.im(USERS.bob).messages.at(-1)!;
    expect(text(dm)).toContain("asked you for 2 things");
    // Three buttons per ask, the rest behind the overflow menu.
    const elements = (dm.blocks ?? []).flatMap((b) => (b.elements as { action_id: string; options?: { value: string }[] }[]) ?? []);
    const ids = elements.flatMap((e) => (e.options ? e.options.map((o) => o.value.split("|")[0]!) : [e.action_id]));
    expect(ids).toEqual(expect.arrayContaining(["ask:accept_now", "ask:accept_later", "ask:done", "ask:reject", "ask:send_back"]));
    expect(elements.filter((e) => e.action_id !== "ask:overflow").length / 2).toBeLessThanOrEqual(3);
    expect(h.errors).toEqual([]);
  });

  it("a check from the tagger is refused with 'Needs a check from ...' and nothing is created", async () => {
    const t = await tagThread(h);
    await h.react(USERS.tara, { channel: CHANNEL, ts: t.card.ts }, "white_check_mark");
    expect(h.requests()[0]!.status).toBe("pending_confirmation");
    expect(h.asks()).toHaveLength(0);
    expect(threadReplies(t.root.ts).at(-1)).toBe(`Needs a ✅ from <@${USERS.dana}> or <@${USERS.bob}>.`);
  });

  it("the owner can confirm too", async () => {
    const t = await tagThread(h);
    await h.react(USERS.bob, { channel: CHANNEL, ts: t.card.ts }, "+1");
    expect(h.requests()[0]).toMatchObject({ status: "confirmed", confirmed_by: USERS.bob });
  });

  it("a cross reaction asks what is off", async () => {
    const t = await tagThread(h);
    await h.react(USERS.dana, { channel: CHANNEL, ts: t.card.ts }, "x");
    expect(threadReplies(t.root.ts).at(-1)).toContain("What's off");
    expect(h.requests()[0]!.status).toBe("pending_confirmation");
  });

  describe("an unrecognized emoji", () => {
    const meaning = (choice: string, p?: number) => h.systemOne.queueChoice("meaning", choice, p);

    it("is read by System One: the options are yes, no and unclear, and the state names the emoji, the reactor and the asks", async () => {
      const t = await tagThread(h);
      meaning("unclear");
      h.anthropic.queueText("Anything off?");
      await h.react(USERS.dana, { channel: CHANNEL, ts: t.card.ts }, "tada");
      await h.drain();
      const req = h.systemOne.requests[0]!;
      expect(Object.keys((req.questions.meaning as { criteria: object }).criteria)).toEqual(["yes", "no", "unclear"]);
      expect(req.state).toMatchObject({ emoji: "tada", reacted_by: USERS.dana, confirmation: { requester: USERS.dana, owner: USERS.bob, asks: ["Send the Q3 numbers"] } });
    });

    it("a yes (p >= 0.8) confirms like a check mark", async () => {
      const t = await tagThread(h, { titles: ["Send the Q3 numbers", "Ping finance"] });
      meaning("yes", 0.8);
      await h.react(USERS.dana, { channel: CHANNEL, ts: t.card.ts }, "rocket");
      await h.drain();
      expect(h.requests()[0]).toMatchObject({ status: "confirmed", confirmed_by: USERS.dana, confirmed_via: "reaction" });
      expect(h.asks()).toHaveLength(2);
      expect(h.slack.dmTexts(USERS.bob).join("\n")).toContain("Send the Q3 numbers");
      expect(h.anthropic.requests.filter((r) => r.model === "anthropic/claude-haiku-5.5")).toHaveLength(0);
    });

    it("a yes on an unresolved request confirms nothing, as a check mark wouldn't", async () => {
      const t = await tagThread(h, { requester: null, clarify: "Who's asking?" });
      meaning("yes", 0.95);
      await h.react(USERS.dana, { channel: CHANNEL, ts: t.card.ts }, "rocket");
      await h.drain();
      expect(h.asks()).toHaveLength(0);
      expect(h.requests()[0]!.status).toBe("pending_confirmation");
    });

    it("a no (p >= 0.8) answers like a cross: what's off", async () => {
      const t = await tagThread(h);
      meaning("no", 0.9);
      await h.react(USERS.dana, { channel: CHANNEL, ts: t.card.ts }, "thinking_face");
      await h.drain();
      expect(threadReplies(t.root.ts).at(-1)).toContain("What's off");
      expect(h.requests()[0]!.status).toBe("pending_confirmation");
    });

    it("unclear keeps the clarifying question from the fast model", async () => {
      const t = await tagThread(h, { confidence: 0.5, clarify: "Who is asking: Dana or Tara?" });
      meaning("unclear", 0.9);
      h.anthropic.queueText("Who is actually asking here, Dana or Tara?");
      await h.react(USERS.dana, { channel: CHANNEL, ts: t.card.ts }, "thinking_face");
      expect(h.queue.sentOfKind("clarify_reaction")).toHaveLength(1);
      await h.drain();
      const clarify = h.anthropic.requests.at(-1)!;
      expect(clarify.model).toBe("anthropic/claude-haiku-5.5");
      expect(clarify.body.tools).toBeUndefined();
      expect(threadReplies(t.root.ts).at(-1)).toBe("Who is actually asking here, Dana or Tara?");
      expect(h.requests()[0]!.status).toBe("pending_confirmation");
    });

    it("a yes or no below 0.8 counts as unclear", async () => {
      const t = await tagThread(h);
      meaning("yes", 0.79);
      await h.react(USERS.dana, { channel: CHANNEL, ts: t.card.ts }, "eyes");
      await h.drain();
      expect(h.requests()[0]!.status).toBe("pending_confirmation");
      expect(threadReplies(t.root.ts).at(-1)).not.toContain("What's off");
    });

    it("a failed System One call falls back to the clarifying question", async () => {
      const t = await tagThread(h);
      h.systemOne.failNext(402);
      await h.react(USERS.dana, { channel: CHANNEL, ts: t.card.ts }, "eyes");
      const r = await h.drain();
      expect(r.retried).toHaveLength(0);
      expect(h.requests()[0]!.status).toBe("pending_confirmation");
      expect(threadReplies(t.root.ts).at(-1)).toBeTruthy();
    });
  });

  it("an uninvolved person's reaction is ignored", async () => {
    const t = await tagThread(h);
    await h.react(USERS.eve, { channel: CHANNEL, ts: t.card.ts }, "white_check_mark");
    expect(h.requests()[0]!.status).toBe("pending_confirmation");
  });

  it("does not confirm when the attribution is unresolved", async () => {
    const t = await tagThread(h, { requester: null, clarify: "Who's asking?" });
    await h.react(USERS.dana, { channel: CHANNEL, ts: t.card.ts }, "white_check_mark");
    expect(h.asks()).toHaveLength(0);
  });
});

describe("corrections and thread replies", () => {
  it("a correction reply re-extracts and updates the same card", async () => {
    const t = await tagThread(h, { requester: USERS.tara, owner: USERS.bob });
    const before = h.slack.message(CHANNEL, t.card.ts);
    expect(text(before)).toContain(`<@${USERS.tara}>`);

    h.anthropic.queueToolUse("record_asks", extractionInput({
      requester: USERS.dana, owner: USERS.bob, asks: [{ title: "Send the Q3 numbers", source_ts: t.root.ts }],
    }));
    const fix = await h.say({ user: USERS.tara, text: "no, Dana is the one asking", thread_ts: t.root.ts });
    expect(h.queue.sentOfKind("correct")).toEqual([
      { kind: "correct", requestId: t.requestId, userId: USERS.tara, text: fix.text, messageTs: fix.ts },
    ]);
    await h.drain();

    const prompt = h.anthropic.requests.at(-1)!.prompt;
    expect(prompt).toContain("no, Dana is the one asking");
    expect(h.requests()[0]).toMatchObject({ requester_id: USERS.dana, status: "pending_confirmation" });
    const after = h.slack.message(CHANNEL, t.card.ts);
    expect(after.ts).toBe(t.card.ts);
    expect(text(after)).toContain(`*<@${USERS.dana}>* is asking`);
    expect(h.requests()).toHaveLength(1);
  });

  it("an affirming reply confirms", async () => {
    const t = await tagThread(h);
    await h.say({ user: USERS.dana, text: "yes", thread_ts: t.root.ts });
    await h.drain();
    expect(h.requests()[0]).toMatchObject({ status: "confirmed", confirmed_via: "thread_reply" });
  });

  it("replies from people outside the request are not queued", async () => {
    const t = await tagThread(h);
    await h.say({ user: USERS.eve, text: "unrelated chatter", thread_ts: t.root.ts });
    expect(h.queue.sentOfKind("correct")).toHaveLength(0);
  });

  it("the bot's own message events do not loop", async () => {
    const t = await tagThread(h);
    const before = h.queue.sent.length;
    const ev = {
      type: "message", channel: CHANNEL, user: "UBOT", bot_id: "B0001", text: "x", ts: t.card.ts, thread_ts: t.root.ts, event_ts: t.card.ts,
    };
    await h.ingress.event(ev);
    expect(h.queue.sent.length).toBe(before);
  });
});
