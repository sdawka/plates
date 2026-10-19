import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHANNEL, USERS, createHarness, type Harness } from "../helpers/env";
import { flatText } from "../helpers/fakeSlack";
import { tagAndConfirm, type Tagged } from "../helpers/scenario";

let h: Harness;
beforeEach(() => void (h = createHarness()));
afterEach(() => h.dispose());

const HOUR = 3_600_000;
const decision = (o: Record<string, unknown> = {}) => ({
  action: "accept_now", ask_id: "A1", note: null, deadline: null, confidence: 0.95, delivers_ask_id: null, ...o,
});
const ask = (i = 0) => h.asks()[i]!;
const askState = (i = 0) => ask(i).state;
const proposals = () => h.q("SELECT * FROM proposals ORDER BY rowid");

/** A confirmed one-ask request, plus a reply by `user` in its thread that the (scripted) model classifies as `d`. */
async function reply(t: Tagged, user: string, text: string, d: Record<string, unknown> | null, files?: Record<string, unknown>[]) {
  if (d) h.anthropic.queueToolUse("decide_action", d);
  const msg = await h.say({ user, text, thread_ts: t.root.ts, files });
  await h.drain();
  return msg;
}
const lastThreadBot = (t: Tagged) => h.slack.botMessages(CHANNEL).filter((m) => m.thread_ts === t.root.ts).at(-1)!;
const ref = (m: { ts: string }) => ({ channel: CHANNEL, ts: m.ts });
const ephemeralTo = (u: string) => h.slack.ephemerals.filter((e) => e.user === u).map((e) => e.text);

describe("intent: confident replies apply with Undo", () => {
  it("'on it' from the owner is applied, announced in the thread with an Undo button", async () => {
    const t = await tagAndConfirm(h);
    await reply(t, USERS.bob, "on it", decision());
    expect(askState()).toBe("in_progress");
    const line = lastThreadBot(t);
    expect(flatText(line)).toContain(`✓ <@${USERS.bob}>`);
    expect(flatText(line)).toContain("accepted, working on it");
    const undo = line.blocks!.flatMap((b) => (b.elements as { action_id: string }[] | undefined) ?? []).find((e) => e.action_id === "event:undo");
    expect(undo).toBeTruthy();
    expect(h.events(ask().id as string).at(-1)).toMatchObject({ kind: "accept_now", via: "thread_reply", actor_id: USERS.bob, source_ts: expect.any(String) });
    expect(h.errors).toEqual([]);
  });

  it("someone else cannot undo it; the actor can, and the line becomes 'Undone'", async () => {
    const t = await tagAndConfirm(h);
    await reply(t, USERS.bob, "on it", decision());
    const line = lastThreadBot(t);

    await h.click(USERS.dana, ref(line), "event:undo");
    expect(ephemeralTo(USERS.dana)).toEqual(["Only the person who did this can undo it."]);
    expect(askState()).toBe("in_progress");

    await h.click(USERS.bob, ref(line), "event:undo");
    expect(askState()).toBe("proposed");
    expect(flatText(h.slack.message(CHANNEL, line.ts))).toContain("Undone");
    expect(h.events(ask().id as string).map((e) => e.kind)).toEqual(["accept_now", "undo"]);
    expect(h.errors).toEqual([]);
  });

  it("Undo after the 15 minute window is refused", async () => {
    const t = await tagAndConfirm(h);
    await reply(t, USERS.bob, "on it", decision());
    const line = lastThreadBot(t);
    h.clock.set(h.clock.now() + 16 * 60_000);
    await h.click(USERS.bob, ref(line), "event:undo");
    expect(ephemeralTo(USERS.bob).at(-1)).toBe("It's too late to undo that. Use the buttons instead.");
    expect(askState()).toBe("in_progress");
  });

  it("a reply from someone with no stake in the request is not even sent to the model", async () => {
    const t = await tagAndConfirm(h);
    await h.say({ user: USERS.eve, text: "on it", thread_ts: t.root.ts });
    expect(h.queue.sentOfKind("intent")).toHaveLength(0);
    expect(h.anthropic.requests).toHaveLength(1); // only the extraction
  });

  it("chatter ('none') changes nothing and posts nothing", async () => {
    const t = await tagAndConfirm(h);
    const before = h.slack.botMessages(CHANNEL).length;
    await reply(t, USERS.bob, "lol ok", decision({ action: "none", ask_id: null, confidence: 0.2 }));
    expect(askState()).toBe("proposed");
    expect(h.slack.botMessages(CHANNEL)).toHaveLength(before);
  });
});

describe("intent: low confidence asks 'Did you mean'", () => {
  const unsure = () => decision({ confidence: 0.5 });

  it("Yes applies the action, No dismisses it", async () => {
    const t = await tagAndConfirm(h);
    await reply(t, USERS.bob, "maybe I can start", unsure());
    expect(askState()).toBe("proposed");
    const prop = lastThreadBot(t);
    expect(flatText(prop)).toContain("Did you mean: Accept now");
    expect(proposals()).toMatchObject([{ status: "pending", actor_id: USERS.bob, source: "reply", message_ts: prop.ts }]);

    await h.click(USERS.bob, ref(prop), "prop:yes", proposals()[0]!.id as string);
    expect(askState()).toBe("in_progress");
    expect(proposals()[0]!.status).toBe("applied");
    expect(flatText(h.slack.message(CHANNEL, prop.ts))).toContain("accepted, working on it");

    // a second proposal on a fresh ask, answered No
    const t2 = await tagAndConfirm(h, { titles: ["Send the deck"] });
    await reply(t2, USERS.bob, "hmm let me see", unsure());
    const p2 = lastThreadBot(t2);
    await h.click(USERS.bob, ref(p2), "prop:no", proposals().at(-1)!.id as string);
    expect(h.asks().find((a) => a.title === "Send the deck")!.state).toBe("proposed");
    expect(proposals().at(-1)!.status).toBe("dismissed");
    expect(flatText(h.slack.message(CHANNEL, p2.ts))).toContain("Okay, ignored.");
    expect(h.errors).toEqual([]);
  });

  it("only the person who spoke can answer", async () => {
    const t = await tagAndConfirm(h);
    await reply(t, USERS.bob, "maybe I can start", unsure());
    const prop = lastThreadBot(t);
    for (const who of [USERS.dana, USERS.tara]) await h.click(who, ref(prop), "prop:yes", proposals()[0]!.id as string);
    expect(ephemeralTo(USERS.dana)).toEqual([`This is for <@${USERS.bob}>.`]);
    expect(ephemeralTo(USERS.tara)).toEqual([`This is for <@${USERS.bob}>.`]);
    expect(askState()).toBe("proposed");
    expect(proposals()[0]!.status).toBe("pending");
  });

  it("with several asks the speaker picks which one, then confirms", async () => {
    const t = await tagAndConfirm(h, { titles: ["Send the Q3 numbers", "Send the Q3 deck"] });
    await reply(t, USERS.bob, "starting on one of these", decision({ ask_id: null, confidence: 0.9 }));
    expect(h.asks().map((a) => a.state)).toEqual(["proposed", "proposed"]);
    const prop = lastThreadBot(t);
    const pid = proposals()[0]!.id as string;
    expect(proposals()[0]!.ask_id).toBeNull();

    // Yes before picking: nudged to pick
    await h.click(USERS.bob, ref(prop), "prop:yes", pid);
    expect(ephemeralTo(USERS.bob).at(-1)).toBe("Pick which ask you mean first.");

    const second = h.asks().find((a) => a.title === "Send the Q3 deck")!;
    await h.choose(USERS.bob, ref(prop), "prop:pick", `${pid}|${second.id}`);
    expect(proposals()[0]!.ask_id).toBe(second.id);
    expect(flatText(h.slack.message(CHANNEL, prop.ts))).toContain("Send the Q3 deck");

    await h.click(USERS.bob, ref(prop), "prop:yes", pid);
    expect(h.asks().map((a) => [a.title, a.state]).sort()).toEqual([["Send the Q3 deck", "in_progress"], ["Send the Q3 numbers", "proposed"]]);
    expect(h.errors).toEqual([]);
  });

  it("a suggestion expires after 24 hours: the click only says so, and nothing is applied", async () => {
    const t = await tagAndConfirm(h);
    await reply(t, USERS.bob, "maybe I can start", unsure());
    const prop = lastThreadBot(t);
    h.clock.set(h.clock.now() + 25 * HOUR);
    await h.click(USERS.bob, ref(prop), "prop:yes", proposals()[0]!.id as string);
    expect(askState()).toBe("proposed");
    expect(proposals()[0]!.status).toBe("expired");
    expect(flatText(h.slack.message(CHANNEL, prop.ts))).toContain("expired");
    // and it stays expired
    await h.click(USERS.bob, ref(prop), "prop:yes", proposals()[0]!.id as string).catch(() => {});
    expect(askState()).toBe("proposed");
  });
});

describe("intent: queue redelivery", () => {
  it("a redelivered intent job neither calls the model nor applies twice", async () => {
    const t = await tagAndConfirm(h);
    await reply(t, USERS.bob, "on it", decision());
    const job = h.queue.sentOfKind("intent")[0]!;
    const requests = h.anthropic.requests.length;
    const posts = h.slack.botMessages(CHANNEL).length;

    await h.queue.send(job);
    await h.drain();
    expect(h.anthropic.requests).toHaveLength(requests);
    expect(h.slack.botMessages(CHANNEL)).toHaveLength(posts);
    expect(h.events(ask().id as string).filter((e) => e.kind === "accept_now")).toHaveLength(1);
  });

  it("the same holds for a pending proposal", async () => {
    const t = await tagAndConfirm(h);
    await reply(t, USERS.bob, "maybe", decision({ confidence: 0.4 }));
    const job = h.queue.sentOfKind("intent")[0]!;
    await h.queue.send(job);
    await h.drain();
    expect(proposals()).toHaveLength(1);
  });

  it("a transient 529 from the model is retried and still applies exactly once", async () => {
    const t = await tagAndConfirm(h);
    h.anthropic.failNext(529);
    await reply(t, USERS.bob, "on it", decision());
    // the model client retries a 529 on its own; the queue never sees a failure
    expect(h.anthropic.requests.filter((r) => r.answeredWith === "error")).toHaveLength(1);
    expect(h.queue.retried).toHaveLength(0);
    expect(h.events(ask().id as string).filter((e) => e.kind === "accept_now")).toHaveLength(1);
    expect(askState()).toBe("in_progress");
  });
});

describe("intent: 'looks done?' detector", () => {
  const link = "https://docs.test/q3-numbers";

  it("an owner sharing a link gets a proposal to mark the ask done, with the link attached", async () => {
    const t = await tagAndConfirm(h);
    await reply(t, USERS.bob, `here <${link}>`, decision({ action: "none", ask_id: null, confidence: 0.3, delivers_ask_id: "A1" }));
    expect(askState()).toBe("proposed");
    const prop = lastThreadBot(t);
    expect(flatText(prop)).toContain("Looks like this delivers");
    expect(proposals()).toMatchObject([{ source: "detector", status: "pending", actor_id: USERS.bob }]);
    expect(JSON.parse(proposals()[0]!.action_json as string)).toEqual({ kind: "done", link });

    await h.click(USERS.bob, ref(prop), "prop:yes", proposals()[0]!.id as string);
    expect(ask()).toMatchObject({ state: "delivered", done_link: link, holder_id: USERS.dana });
    expect(h.slack.dmTexts(USERS.dana).join("\n")).toContain(link);
    expect(h.errors).toEqual([]);
  });

  it("a file upload works the same way, and a second share while one is pending does not ask again", async () => {
    const t = await tagAndConfirm(h);
    const file = { id: "F1", name: "q3.xlsx", title: "Q3 numbers.xlsx", permalink: "https://plates-test.slack.com/files/UBOB/F1/q3.xlsx" };
    await reply(t, USERS.bob, "", decision({ action: "none", ask_id: null, confidence: 0.3, delivers_ask_id: "A1" }), [file]);
    expect(proposals()).toHaveLength(1);
    expect(JSON.parse(proposals()[0]!.action_json as string)).toEqual({ kind: "done", link: file.permalink });

    await reply(t, USERS.bob, `also <${link}>`, decision({ action: "none", ask_id: null, confidence: 0.3, delivers_ask_id: "A1" }));
    expect(proposals()).toHaveLength(1);
  });

  it("the requester sharing a link is never offered 'mark done'", async () => {
    const t = await tagAndConfirm(h);
    await reply(t, USERS.dana, `fyi <${link}>`, decision({ action: "none", ask_id: null, confidence: 0.3, delivers_ask_id: "A1" }));
    expect(proposals()).toHaveLength(0);
  });

  it("a plain message without a link or file never triggers it, whatever the model says", async () => {
    const t = await tagAndConfirm(h);
    await reply(t, USERS.bob, "finished it, will send later", decision({ action: "none", ask_id: null, confidence: 0.3, delivers_ask_id: "A1" }));
    expect(proposals()).toHaveLength(0);
  });
});
