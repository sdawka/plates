import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { USERS, createHarness, type Harness } from "../helpers/env";
import { validateBlocks, validateView } from "../helpers/blockKit";
import { flatText } from "../helpers/fakeSlack";
import { mkDraft, seedRequest } from "../helpers/seed";

let h: Harness;
beforeEach(() => void (h = createHarness()));
afterEach(() => h.dispose());

const long = (n: number) => "x".repeat(n);

describe("Home tab stays within Slack's limits", () => {
  it("many asks in every state: publish succeeds with <=100 blocks", async () => {
    const states = ["proposed", "in_progress", "accepted", "snoozed", "delivered", "rejected", "clarify"] as const;
    for (let r = 0; r < 12; r++) {
      await seedRequest(h, {}, Array.from({ length: 12 }, (_, i) => ({
        title: `Request ${r} ask ${i} ${long(i % 3 === 0 ? 400 : 20)}`,
        detail: long(500),
        state: states[(r + i) % states.length]!,
        snoozed_until: Date.now() + 3_600_000,
        snooze_count: i % 5,
        deadline_at: Date.now() + i * 86_400_000,
      })));
      // Asks the other way round too, so everything also shows under "Waiting on others".
      await seedRequest(h, { requester_id: USERS.bob, owner_id: USERS.dana }, Array.from({ length: 5 }, (_, i) => ({
        requester_id: USERS.bob, owner_id: USERS.dana, holder_id: USERS.dana, title: `Reverse ${r}.${i}`, state: states[i % 3]!,
      })));
    }
    for (let i = 0; i < 20; i++) {
      await seedRequest(h, { status: i % 2 ? "discarded" : "pending_confirmation", owner_id: USERS.dana, requester_id: USERS.bob,
        draft_json: JSON.stringify([mkDraft(i, { title: long(300) }), mkDraft(i + 100)]) });
    }

    for (const user of [USERS.bob, USERS.dana]) {
      await h.openHome(user);
      const view = h.slack.homeViews.get(user)!;
      expect(view, `${user} published`).toBeTruthy();
      expect(view.blocks.length).toBeLessThanOrEqual(100);
      expect(validateView(view, "home")).toEqual([]);
    }
    expect(h.slack.callsTo("views.publish").every((c) => c.ok)).toBe(true);
    expect(h.errors).toEqual([]);
  });

  it("an empty Home still publishes", async () => {
    await h.openHome(USERS.eve);
    const text = flatText(h.slack.homeViews.get(USERS.eve)!);
    expect(text).toContain("Your plate is clear");
  });
});

describe("thread messages stay within 50 blocks", () => {
  // src gap: extraction does not cap the number of asks per request, and a confirmed request renders one
  // section per ask plus a header, so >49 asks make chat.postMessage fail with invalid_blocks.
  // Fix: cap asks per request in extraction validation (or paginate the live message).
  it("a request with 60 asks can be confirmed and rendered", async () => {
    const root = await h.say({ user: USERS.dana, text: `<@${USERS.bob}> lots of work for you` });
    h.anthropic.queueToolUse("record_asks", {
      groups: [{ requester_id: USERS.dana, owner_id: USERS.bob, attribution_confidence: 0.9, attribution_reason: "r", clarify_question: null,
        asks: Array.from({ length: 60 }, (_, i) => ({ title: `Task ${i}`, type: "deliverable", size: "lt1h", urgency: "normal",
          estimate_reason: "e", owner_already_committed: false, source_ts: root.ts })) }],
    });
    await h.say({ user: USERS.tara, text: "<@UBOT> track all", thread_ts: root.ts });
    await h.drain();
    const req = h.requests()[0]!;
    await h.react(USERS.dana, { channel: req.channel_id as string, ts: req.message_ts as string }, "white_check_mark");
    expect(h.errors).toEqual([]);
  });
});

describe("the Block Kit validator itself", () => {
  const msg = (blocks: unknown) => validateBlocks(blocks, "message");
  const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } });

  it("accepts the documented maximums", () => {
    expect(msg(Array.from({ length: 50 }, () => section(long(3000))))).toEqual([]);
    expect(validateBlocks(Array.from({ length: 100 }, () => ({ type: "divider" })), "home")).toEqual([]);
  });

  it.each([
    ["51 blocks in a message", Array.from({ length: 51 }, () => ({ type: "divider" })), /too many blocks/],
    ["section text over 3000", [section(long(3001))], /max 3000/],
    ["empty section text", [section("")], /at least 1/],
    ["bad text type", [{ type: "section", text: { type: "html", text: "x" } }], /plain_text or mrkdwn/],
    ["button text over 75", [{ type: "actions", elements: [{ type: "button", action_id: "a", text: { type: "plain_text", text: long(76) } }] }], /max 75/],
    ["button mrkdwn text", [{ type: "actions", elements: [{ type: "button", action_id: "a", text: { type: "mrkdwn", text: "x" } }] }], /plain_text/],
    ["button value over 2000", [{ type: "actions", elements: [{ type: "button", action_id: "a", text: { type: "plain_text", text: "x" }, value: long(2001) }] }], /2000/],
    ["action_id over 255", [{ type: "actions", elements: [{ type: "button", action_id: long(256), text: { type: "plain_text", text: "x" } }] }], /max 255/],
    ["duplicate action_ids", [{ type: "actions", elements: [
      { type: "button", action_id: "a", text: { type: "plain_text", text: "x" } },
      { type: "button", action_id: "a", text: { type: "plain_text", text: "y" } }] }], /duplicate action_id/],
    ["overflow with 1 option", [{ type: "actions", elements: [{ type: "overflow", action_id: "o", options: [{ text: { type: "plain_text", text: "a" }, value: "a" }] }] }], /2 to 5/],
    ["overflow with 6 options", [{ type: "actions", elements: [{ type: "overflow", action_id: "o",
      options: Array.from({ length: 6 }, (_, i) => ({ text: { type: "plain_text", text: `o${i}` }, value: `${i}` })) }] }], /2 to 5/],
    ["static_select with 101 options", [{ type: "actions", elements: [{ type: "static_select", action_id: "s",
      options: Array.from({ length: 101 }, (_, i) => ({ text: { type: "plain_text", text: `o${i}` }, value: `${i}` })) }] }], /at most 100/],
    ["duplicate block_ids", [{ type: "divider", block_id: "b" }, { type: "divider", block_id: "b" }], /duplicate block_id/],
    ["input block in a message", [{ type: "input", label: { type: "plain_text", text: "l" }, element: { type: "plain_text_input", action_id: "v" } }], /only allowed in modals/],
    ["unknown block type", [{ type: "carousel" }], /unknown block type/],
    ["header with mrkdwn", [{ type: "header", text: { type: "mrkdwn", text: "x" } }], /plain_text/],
    ["context with 11 elements", [{ type: "context", elements: Array.from({ length: 11 }, () => ({ type: "mrkdwn", text: "x" })) }], /at most 10/],
  ])("rejects %s", (_name, blocks, re) => {
    expect(msg(blocks).join("\n")).toMatch(re);
  });

  it("rejects over 100 blocks on Home and a modal with input but no submit", () => {
    expect(validateBlocks(Array.from({ length: 101 }, () => ({ type: "divider" })), "home").join()).toMatch(/max 100/);
    const modal = { type: "modal", title: { type: "plain_text", text: "t" }, blocks: [
      { type: "input", block_id: "i", label: { type: "plain_text", text: "l" }, element: { type: "plain_text_input", action_id: "v" } }] };
    expect(validateView(modal, "modal").join()).toMatch(/submit is required/);
    expect(validateView({ ...modal, title: { type: "plain_text", text: long(25) }, submit: { type: "plain_text", text: "ok" } }, "modal").join()).toMatch(/max 24/);
  });

  it("turns a violation into the documented invalid_blocks error", async () => {
    const res = await fetch("https://slack.test/api/chat.postMessage", {
      method: "POST",
      headers: { authorization: "Bearer xoxb-test-token", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ channel: "C100", text: "x", blocks: JSON.stringify([section(long(3001))]) }),
    });
    const body = (await res.json()) as { ok: boolean; error: string; response_metadata: { messages: string[] } };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("invalid_blocks");
    expect(body.response_metadata.messages[0]).toContain("max 3000");
  });
});
