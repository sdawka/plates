import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHANNEL, USERS, createHarness, type Harness } from "../helpers/env";
import { dispatch } from "../../src/effects";
import { tagAndConfirm, tagThread } from "../helpers/scenario";

let h: Harness;
beforeEach(() => void (h = createHarness()));
afterEach(() => h.dispose());

describe("@plates in a thread that already has a request", () => {
  it("a correction mention on a pending request queues a correct job, not a second extract", async () => {
    const t = await tagThread(h);
    const extracts = h.queue.sentOfKind("extract").length;
    const reply = await h.say({ user: USERS.dana, text: "<@UBOT> it's Carol not Bob", thread_ts: t.root.ts });
    expect(h.queue.sentOfKind("extract")).toHaveLength(extracts);
    expect(h.queue.sentOfKind("correct")).toEqual([
      { kind: "correct", requestId: t.requestId, userId: USERS.dana, text: reply.text, messageTs: reply.ts },
    ]);
    expect(h.slack.posts({ thread_ts: t.root.ts }).filter((p) => p.args.text === "Reading the thread…")).toHaveLength(1);
  });

  it("a mention on a confirmed request queues an intent job", async () => {
    const t = await tagAndConfirm(h);
    const extracts = h.queue.sentOfKind("extract").length;
    await h.say({ user: USERS.dana, text: "<@UBOT> close it", thread_ts: t.root.ts });
    expect(h.queue.sentOfKind("extract")).toHaveLength(extracts);
    expect(h.queue.sentOfKind("intent")).toHaveLength(1);
  });

  it("a thread_broadcast reply is handled like a thread reply", async () => {
    const t = await tagThread(h);
    const msg = h.slack.addHumanMessage({ channel: CHANNEL, user: USERS.dana, text: "actually it's Carol", thread_ts: t.root.ts });
    const event = { ...h.ingress.messageEvent({ channel: CHANNEL, user: USERS.dana, text: msg.text, ts: msg.ts, thread_ts: t.root.ts }), subtype: "thread_broadcast" };
    expect((await h.ingress.event(event)).status).toBe(200);
    expect(h.queue.sentOfKind("correct")).toMatchObject([{ requestId: t.requestId, userId: USERS.dana, messageTs: msg.ts }]);
  });
});

describe("/plates broadcast mentions", () => {
  it("are neutralized in the bot's repost", async () => {
    await h.ingress.slashCommand({ user: USERS.dana, channel: CHANNEL, text: "<!channel> <!here> <!subteam^S1> send the deck" });
    const [post] = h.slack.posts({ channel: CHANNEL });
    expect(post!.args.text).not.toContain("<!");
    expect(post!.args.text).toContain("&lt;!channel>");
    expect(post!.args.text).toContain("&lt;!subteam^S1>");
  });
});

describe("modals open before the slow lookups", () => {
  it("settings opens a loading modal, then views.update fills it using view_id and hash", async () => {
    await h.ingress.slashCommand({ user: USERS.dana, channel: CHANNEL, text: "settings" });
    const [open] = h.slack.callsTo("views.open");
    const [update] = h.slack.callsTo("views.update");
    const view = open!.response.view as { id: string; hash: string };
    expect(open!.args.view).toMatchObject({ blocks: [{ text: { text: "Loading…" } }] });
    expect(update!.args).toMatchObject({ view_id: view.id, hash: view.hash });
    expect(h.slack.lastModal().callback_id).toBe("settings:save");
    expect(h.errors).toEqual([]);
  });

  it("set_deadline opens a loading modal, then fills it", async () => {
    const t = await tagAndConfirm(h);
    const askId = h.asks()[0]!.id as string;
    const dm = { channel: h.slack.im(USERS.bob).id, ts: h.slack.im(USERS.bob).messages.at(-1)!.ts };
    await h.click(USERS.bob, dm, "ask:accept_later", askId);
    await h.submit(USERS.bob, { date: "2026-10-22" });
    h.clock.advance(60_000);
    const opens = h.slack.callsTo("views.open").length;
    const updates = h.slack.callsTo("views.update").length;
    await h.choose(USERS.bob, { channel: CHANNEL, ts: t.card.ts }, "ask:overflow", `ask:set_deadline|${askId}`);
    const open = h.slack.callsTo("views.open")[opens];
    const update = h.slack.callsTo("views.update")[updates];
    const view = open!.response.view as { id: string; hash: string };
    expect(open!.args.view).toMatchObject({ blocks: [{ text: { text: "Loading…" } }] });
    expect(update!.args).toMatchObject({ view_id: view.id, hash: view.hash });
    expect(h.slack.lastModal().callback_id).toBe("modal:set_deadline");
    expect(h.errors).toEqual([]);
  });
});

describe("render_request concurrency", () => {
  it("two renders of an unposted request leave exactly one message", async () => {
    const t = await tagThread(h);
    await h.db.prepare("UPDATE requests SET message_ts = NULL WHERE id = ?").bind(t.requestId).run();
    const before = h.slack.botMessages(CHANNEL).length;
    const effect = { kind: "render_request" as const, requestId: t.requestId };
    const failed = await Promise.all([dispatch(h.env, [effect]), dispatch(h.env, [effect])]);
    expect(failed).toEqual([[], []]);
    expect(h.slack.botMessages(CHANNEL)).toHaveLength(before + 1);
    expect(h.slack.callsTo("chat.delete")).toHaveLength(1);
    const [row] = h.requests();
    expect(h.slack.botMessages(CHANNEL).map((m) => m.ts)).toContain(row!.message_ts);
  });
});
