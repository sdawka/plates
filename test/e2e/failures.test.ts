import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHANNEL, USERS, createHarness, type Harness } from "../helpers/env";

let h: Harness;
beforeEach(() => void (h = createHarness()));
afterEach(() => h.dispose());

describe("extraction that keeps failing", () => {
  it("retries, then tells the thread instead of leaving \"Reading the thread…\" forever", async () => {
    const root = await h.say({ user: USERS.dana, text: `<@${USERS.bob}> can you send the Q3 numbers?` });
    await h.say({ user: USERS.tara, text: "<@UBOT> track this", thread_ts: root.ts });

    // Nothing scripted for Anthropic: every attempt gets a 400 from the API.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await h.drain();
      expect(r.retried, `attempt ${attempt}`).toHaveLength(1);
    }
    const last = await h.drain();
    expect(last.acked).toHaveLength(1);
    expect(last.deadLettered).toHaveLength(0);

    // The placeholder is edited into the failure note: one bot message in the thread, not two.
    const posts = h.slack.posts({ thread_ts: root.ts }).map((p) => String(p.args.text));
    expect(posts).toEqual(["👀 Reading the thread…"]);
    const inThread = h.slack.botMessages(CHANNEL).filter((m) => m.thread_ts === root.ts).map((m) => m.text);
    expect(inThread).toHaveLength(1);
    expect(inThread[0]).toContain("something went wrong");
    expect(h.requests()).toHaveLength(0);
  });
});
