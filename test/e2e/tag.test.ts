import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHANNEL, USERS, createHarness, type Harness } from "../helpers/env";
import { text, tagThread } from "../helpers/scenario";

let h: Harness;
beforeEach(() => void (h = createHarness()));
afterEach(() => h.dispose());

describe("signature and ingress", () => {
  it("answers url_verification with the challenge", async () => {
    const res = await h.ingress.urlVerification("abc123");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("abc123");
  });

  it("rejects a bad signature, a stale timestamp and the wrong secret", async () => {
    const ev = h.ingress.messageEvent({ channel: CHANNEL, user: USERS.dana, text: "hi", ts: "1.1" });
    expect((await h.ingress.event(ev, { signature: "v0=deadbeef" })).status).toBe(401);
    expect((await h.ingress.event(ev, { timestamp: Math.floor(h.clock.now() / 1000) - 600 })).status).toBe(401);
    expect((await h.ingress.event(ev, { secret: "other" })).status).toBe(401);
  });

  it("acks Slack retries without processing them twice", async () => {
    const root = h.slack.addHumanMessage({ channel: CHANNEL, user: USERS.dana, text: "x" });
    const ev = h.ingress.appMentionEvent({ channel: CHANNEL, user: USERS.tara, text: "<@UBOT> hi", ts: root.ts });
    expect((await h.ingress.event(ev, { retryNum: 1 })).status).toBe(200);
    expect(h.queue.sent).toHaveLength(0);
  });
});

describe("tagging @plates in a thread", () => {
  it("acknowledges, extracts on the queue and posts a confirmation naming requester, owner and tagger", async () => {
    const root = await h.say({ user: USERS.dana, text: `<@${USERS.bob}> can you send the Q3 numbers by Friday?` });
    const tag = await h.say({ user: USERS.tara, text: "<@UBOT> put this on Bob's plate", thread_ts: root.ts });

    // Immediate ack in the thread, extraction deferred to the queue.
    const ack = h.slack.posts({ thread_ts: root.ts });
    expect(ack).toHaveLength(1);
    expect(ack[0]!.args).toMatchObject({ channel: CHANNEL, thread_ts: root.ts, text: "Reading the thread…" });
    expect(h.queue.sentOfKind("extract")).toEqual([
      { kind: "extract", channelId: CHANNEL, threadTs: root.ts, messageTs: tag.ts, taggerId: USERS.tara, text: tag.text },
    ]);
    expect(h.requests()).toHaveLength(0);

    h.anthropic.queueToolUse("record_asks", {
      groups: [{
        requester_id: USERS.dana, owner_id: USERS.bob, attribution_confidence: 0.95, attribution_reason: "Dana asked Bob",
        clarify_question: null,
        asks: [{ title: "Send the Q3 numbers", detail: null, type: "deliverable", size: "hours", urgency: "normal",
          estimate_reason: "spreadsheet", inferred_due_at: null, owner_already_committed: false, source_ts: root.ts }],
      }],
    });
    const res = await h.drain();
    expect(res.acked).toHaveLength(1);
    expect(res.retried).toHaveLength(0);

    // The model saw the thread, with names and the bot message excluded.
    const call = h.anthropic.requests[0]!;
    expect(call.model).toBe("anthropic/claude-sonnet-5.5");
    expect(call.forcedTool).toBeNull(); // Sonnet 5.5 rejects forced tool_choice; strict tool under "auto"
    expect(call.prompt).toContain("UDANA: dana");
    expect(call.prompt).not.toContain("Reading the thread");

    // Confirmation card.
    const [request] = h.requests();
    expect(request).toMatchObject({
      status: "pending_confirmation", requester_id: USERS.dana, owner_id: USERS.bob, tagged_by_id: USERS.tara,
      channel_id: CHANNEL, thread_ts: root.ts,
    });
    const card = h.slack.message(CHANNEL, request!.message_ts as string);
    const body = text(card);
    expect(body).toContain(`<@${USERS.dana}>`);
    expect(body).toContain(`<@${USERS.bob}>`);
    expect(body).toContain(`tagged by <@${USERS.tara}>`);
    expect(body).toContain("Send the Q3 numbers");
    expect(card.thread_ts).toBe(root.ts);

    // Homes refreshed, nothing failed quietly.
    expect(h.slack.callsTo("views.publish").map((c) => c.args.user_id).sort()).toEqual([USERS.bob, USERS.dana, USERS.tara].sort());
    expect(h.errors).toEqual([]);
    expect(h.anthropic.unscripted).toEqual([]);
  });

  it("tags at the top level of a channel using recent history", async () => {
    const msg = await h.say({ user: USERS.dana, text: `<@${USERS.bob}> please review the deck` });
    h.anthropic.queueToolUse("record_asks", {
      groups: [{ requester_id: USERS.dana, owner_id: USERS.bob, attribution_confidence: 0.9, attribution_reason: "r", clarify_question: null,
        asks: [{ title: "Review the deck", type: "deliverable", size: "lt1h", urgency: "normal", estimate_reason: "e", owner_already_committed: false, source_ts: msg.ts }] }],
    });
    const tag = await h.say({ user: USERS.dana, text: "<@UBOT> track this" });
    await h.drain();
    const [req] = h.requests();
    expect(req).toMatchObject({ thread_ts: tag.ts, tag_message_ts: tag.ts });
    expect(h.slack.callsTo("conversations.history")[0]!.args).toMatchObject({ channel: CHANNEL, latest: tag.ts, inclusive: "true" });
  });

  it("asks for an invite when the bot is not in the channel", async () => {
    h.slack.addChannel("C200", { members: [USERS.dana, USERS.tara], botIn: false });
    const root = h.slack.addHumanMessage({ channel: "C200", user: USERS.dana, text: "do it" });
    await h.ingress.event(h.ingress.appMentionEvent({ channel: "C200", user: USERS.tara, text: "<@UBOT> hi", ts: root.ts }));
    // Slack would reject the ack too: not_in_channel on a public channel without membership.
    expect(h.slack.callsTo("chat.postMessage")[0]!.error).toBe("not_in_channel");
  });

  it("is idempotent when the queue redelivers the same tag", async () => {
    const t = await tagThread(h);
    await h.queue.send(h.queue.sentOfKind("extract")[0]!);
    h.anthropic.queueToolUse("record_asks", { groups: [] });
    await h.drain();
    expect(h.requests()).toHaveLength(1);
    expect(t.card).toBeTruthy();
  });

  it("retries the job with a delay when the model call fails, then succeeds", async () => {
    const root = await h.say({ user: USERS.dana, text: `<@${USERS.bob}> ship it` });
    await h.say({ user: USERS.tara, text: "<@UBOT> track", thread_ts: root.ts });
    h.anthropic.failNext(400, "boom");
    const first = await h.drain();
    expect(first.retried).toHaveLength(1);
    expect(first.retried[0]!.delaySeconds).toBe(15);
    h.anthropic.queueToolUse("record_asks", {
      groups: [{ requester_id: USERS.dana, owner_id: USERS.bob, attribution_confidence: 0.9, attribution_reason: "r", clarify_question: null,
        asks: [{ title: "Ship it", type: "deliverable", size: "lt1h", urgency: "normal", estimate_reason: "e", owner_already_committed: false, source_ts: root.ts }] }],
    });
    const second = await h.drain();
    expect(second.acked).toHaveLength(1);
    expect(h.requests()).toHaveLength(1);
  });
});
