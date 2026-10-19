import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHomeView } from "../src/home/view";
import { parseAskSubmission } from "../src/slack/modals";
import { isHttpUrl } from "../src/slack/format";
import type { AskRow } from "../src/types";
import { BOT_USER_ID, CHANNEL, USERS, createHarness, extractionInput, type Harness } from "./helpers/env";
import { tagThread } from "./helpers/scenario";

let h: Harness;
beforeEach(() => void (h = createHarness()));
afterEach(() => h.dispose());

const BAD = ["https://a.com><!channel>", "https://a.com/x|y", "https://a.com/<b"];

describe("done_link escaping (10)", () => {
  it("isHttpUrl and the done modal reject < > |", () => {
    for (const u of BAD) {
      expect(isHttpUrl(u)).toBe(false);
      const r = parseAskSubmission("done", { link: { v: { value: u } }, note: { v: {} } } as never, { now: 0, tz: "UTC" });
      expect(r.ok).toBe(false);
    }
    expect(isHttpUrl("https://a.com/ok?x=1")).toBe(true);
  });

  it("Home renders an unsafe stored link as escaped text, not a Slack link", () => {
    const ask = {
      id: "d", request_id: "r1", requester_id: "UME", owner_id: "UOWN", holder_id: "UME", title: "T", detail: null, type: "deliverable",
      state: "delivered", snoozed_from: null, size: "lt1h", size_source: "llm", urgency: "normal", urgency_source: "llm", estimate_reason: null,
      inferred_due_at: null, deadline_at: null, deadline_change_count: 0, snoozed_until: null, snooze_count: 0, round_count: 0, source_ts: null,
      source_permalink: null, next_step: null, done_link: "https://a.com><!channel>", last_note: null, created_at: 1, accepted_at: null,
      closed_at: null, updated_at: 1, reminder_stage: 0, last_reminded_at: null, last_bumped_at: null, tracker_ref: null, tracker_url: null,
    } as AskRow;
    const out = JSON.stringify(buildHomeView({ plate: [ask], waiting: [], unconfirmed: [] }, "UME", 1_800_000_000_000).blocks);
    expect(out).not.toContain("<!channel>");
    expect(out).toContain("&lt;!channel&gt;");
    expect(out).not.toContain("Open the result");
  });
});

describe("re-capturing a captured message (12)", () => {
  it("a second shortcut capture DMs 'already on a plate' with a permalink", async () => {
    const root = await h.say({ user: USERS.dana, text: `<@${USERS.bob}> please send the Q3 numbers` });
    const capture = () => h.ingress.interaction(h.ingress.messageAction({ user: USERS.tara, callbackId: "plates_capture", channel: CHANNEL, ts: root.ts }));
    await capture();
    h.anthropic.queueToolUse("record_asks", extractionInput({ requester: USERS.dana, owner: USERS.bob, asks: [{ title: "Send the Q3 numbers", source_ts: root.ts }] }));
    await h.drain();
    expect(h.requests()).toHaveLength(1);
    expect(h.slack.dmTexts(USERS.tara).join("\n")).not.toContain("already on a plate");

    await capture();
    await h.drain();
    expect(h.requests()).toHaveLength(1);
    expect(h.slack.dmTexts(USERS.tara).join("\n")).toContain("That's already on a plate:");
    expect(h.errors).toEqual([]);
  });
});

describe("losing the race to confirm (13)", () => {
  it("a correct job leaves a request confirmed mid-flight unchanged and says so", async () => {
    const t = await tagThread(h, { requester: USERS.tara, owner: USERS.bob });
    h.anthropic.queueToolUse("record_asks", extractionInput({ requester: USERS.dana, owner: USERS.bob, asks: [{ title: "Send the Q3 numbers", source_ts: t.root.ts }] }));
    await h.say({ user: USERS.tara, text: "no, Dana is the one asking", thread_ts: t.root.ts });

    // The confirmation lands while the model is still thinking.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input instanceof Request ? input.url : input).includes("/v1/messages")) {
        h.q("UPDATE requests SET status = 'confirmed' WHERE id = ?", t.requestId);
      }
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      await h.drain();
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(h.requests()[0]).toMatchObject({ status: "confirmed", requester_id: USERS.tara });
    const replies = h.slack.posts({ thread_ts: t.root.ts }).map((c) => String(c.args.text));
    expect(replies.at(-1)).toContain("already confirmed");
  });

  it("submitEdit on a confirmed request is refused and changes nothing", async () => {
    const t = await tagThread(h);
    await h.click(USERS.tara, { channel: CHANNEL, ts: t.card.ts }, "req:edit", t.requestId);
    const modal = h.slack.lastModal();
    h.q("UPDATE requests SET status = 'confirmed' WHERE id = ?", t.requestId);
    const res = await h.submit(USERS.tara, { requester: USERS.eve, owner: USERS.bob }, modal);
    expect(res.body).toMatchObject({ response_action: "errors" });
    expect(h.requests()[0]).toMatchObject({ requester_id: USERS.dana });
  });
});

describe("long threads (14)", () => {
  it("a 250-message thread keeps the root and the tag message", async () => {
    const root = await h.say({ user: USERS.dana, text: `ROOTMARK <@${USERS.bob}> can you send the Q3 numbers?` });
    for (let i = 0; i < 250; i++) h.slack.addHumanMessage({ channel: CHANNEL, user: USERS.dana, text: `filler ${i}`, thread_ts: root.ts });
    h.anthropic.queueToolUse("record_asks", extractionInput({ requester: USERS.dana, owner: USERS.bob, asks: [{ title: "Send the Q3 numbers", source_ts: root.ts }] }));
    await h.say({ user: USERS.tara, text: `<@${BOT_USER_ID}> TAGMARK`, thread_ts: root.ts });
    await h.drain();
    const prompt = h.anthropic.requests.at(-1)!.prompt;
    expect(prompt).toContain("ROOTMARK");
    expect(prompt).toContain("TAGMARK");
    expect(prompt).not.toContain("filler 0 ");
  });
});
