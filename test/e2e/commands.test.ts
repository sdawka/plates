import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHANNEL, USERS, createHarness, extractionInput, type Harness } from "../helpers/env";
import { flatText } from "../helpers/fakeSlack";
import { HELP_TEXT } from "../../src/slack/parse";

let h: Harness;
beforeEach(() => void (h = createHarness({ users: [
  { id: USERS.dana, name: "dana", real_name: "Dana Reed", tz: "America/New_York" },
  { id: USERS.bob, name: "bob", real_name: "Bob Ortiz" },
  { id: USERS.tara, name: "tara", real_name: "Tara Lin" },
  { id: USERS.eve, name: "eve", real_name: "Eve Park" },
] })));
afterEach(() => h.dispose());

const slash = (text: string, o: { user?: string; channel?: string } = {}) =>
  h.ingress.slashCommand({ user: o.user ?? USERS.dana, channel: o.channel ?? CHANNEL, text });

describe("/plates help", () => {
  it.each(["", "help", "  HELP "])("answers %j privately with the usage, within the ack", async (text) => {
    const res = await slash(text);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ response_type: "ephemeral", text: HELP_TEXT });
    expect(h.slack.calls).toHaveLength(0);
  });
});

describe("/plates <text> with the bot in the channel", () => {
  it("posts the text as the bot, extracts on the queue and confirms in a new thread", async () => {
    const res = await slash("<@UBOB|bob> send me the Q3 deck by Friday");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");

    const [post] = h.slack.posts({ channel: CHANNEL });
    expect(post!.args.text).toBe(`<@${USERS.dana}> via /plates: <@UBOB> send me the Q3 deck by Friday`);
    const [job] = h.queue.sentOfKind("extract");
    expect(job).toMatchObject({ origin: "command", channelId: CHANNEL, taggerId: USERS.dana, messageTs: post!.response.ts, threadTs: post!.response.ts, text: "<@UBOB> send me the Q3 deck by Friday" });

    h.anthropic.queueToolUse("record_asks", extractionInput({ requester: USERS.dana, owner: USERS.bob, asks: [{ title: "Send the Q3 deck", source_ts: post!.response.ts as string }] }));
    await h.drain();
        const [req] = h.requests();
    expect(req).toMatchObject({ status: "pending_confirmation", channel_id: CHANNEL, thread_ts: post!.response.ts, requester_id: USERS.dana, owner_id: USERS.bob, tagged_by_id: USERS.dana });
    expect(flatText(h.slack.message(CHANNEL, req!.message_ts as string))).toContain("Send the Q3 deck");
    expect(h.errors).toEqual([]);
  });

  it("the extraction prompt knows the ask was typed as a command by the caller", async () => {
    await slash("<@UBOB|bob> send me the Q3 deck by Friday");
    const ts = h.slack.posts()[0]!.response.ts as string;
    h.anthropic.queueToolUse("record_asks", extractionInput({ requester: USERS.dana, owner: USERS.bob, asks: [{ title: "Send the Q3 deck", source_ts: ts }] }));
    await h.drain();
    expect(h.anthropic.requests[0]!.prompt).toContain("/plates");
  });
});

describe("/plates <text> where the bot is not a member", () => {
  it.each([
    ["public channel", { private: false }],
    ["private channel", { private: true }],
  ])("%s: answers through response_url with the invite hint and queues nothing", async (_n, opts) => {
    h.slack.addChannel("C200", { name: "elsewhere", members: [USERS.dana], botIn: false, ...opts });
    expect((await slash("<@UBOB|bob> send the deck", { channel: "C200" })).status).toBe(200);
    expect(h.queue.sent).toHaveLength(0);
    expect(h.slack.responseUrlPosts).toHaveLength(1);
    expect(h.slack.responseUrlPosts[0]!.body).toEqual({ response_type: "ephemeral", text: expect.stringContaining("/invite @plates") });
    expect(h.errors).toEqual([]);
  });
});

describe("/plates settings", () => {
  it("opens a modal prefilled from the Slack profile time zone, saves, and reschedules the keeper", async () => {
    expect((await slash("settings")).status).toBe(200);
    const modal = h.slack.lastModal();
    expect(modal.callback_id).toBe("settings:save");
    const initial = (id: string) => (modal.blocks.find((b) => b.block_id === id)!.element as Record<string, unknown>);
    expect(initial("tz").initial_value).toBe("America/New_York");
    expect(initial("digest").initial_time).toBe("09:00");
    expect(initial("cap").initial_value).toBe("5");

    const res = await h.submit(USERS.dana, { tz: "Europe/Berlin", digest: "08:30", start: "10", end: "18", cap: "3" });
    expect(res).toEqual({ status: 200, body: null });
    expect(h.q("SELECT tz, digest_time, work_start_hour, work_end_hour, max_reminders_per_day FROM user_prefs WHERE user_id = ?", USERS.dana)).toEqual([
      { tz: "Europe/Berlin", digest_time: "08:30", work_start_hour: 10, work_end_hour: 18, max_reminders_per_day: 3 },
    ]);
    // Monday 10:00Z is 12:00 in Berlin: today's 08:30 digest slot (06:30Z) has passed unsent.
    expect(await h.keepers.alarmOf(USERS.dana)).toBe(Date.UTC(2026, 9, 19, 6, 30));
    expect(h.slack.homeViews.get(USERS.dana)).toBeTruthy();

    // reopening shows what was saved, not the profile zone
    await slash("settings");
    expect((h.slack.lastModal().blocks.find((b) => b.block_id === "tz")!.element as Record<string, unknown>).initial_value).toBe("Europe/Berlin");
  });

  it("validation errors stay in the modal and save nothing", async () => {
    await slash("settings");
    const modal = h.slack.lastModal();
    expect((await h.submit(USERS.dana, { tz: "Mars/Olympus" }, modal)).body).toEqual({ response_action: "errors", errors: { tz: expect.stringContaining("valid time zone") } });
    expect((await h.submit(USERS.dana, { start: "12", end: "9" }, modal)).body).toEqual({ response_action: "errors", errors: { end: expect.any(String) } });
    expect((await h.submit(USERS.dana, { cap: "0" }, modal)).body).toEqual({ response_action: "errors", errors: { cap: expect.any(String) } });
    expect((await h.submit(USERS.dana, { cap: "21" }, modal)).body).toEqual({ response_action: "errors", errors: { cap: expect.any(String) } });
    expect(h.q("SELECT * FROM user_prefs WHERE user_id = ?", USERS.dana).filter((r) => r.updated_at !== 0 && r.tz !== "UTC")).toEqual([]);
  });

  it("is also reachable from the Home tab button", async () => {
    await h.openHome(USERS.dana);
    expect((await h.clickHome(USERS.dana, "settings:open", "open")).status).toBe(200);
    expect(h.slack.lastModal().callback_id).toBe("settings:save");
  });

  it("an expired trigger (over 3s) shows nothing and fails quietly", async () => {
    const res = await slash("settings");
    const trigger = h.slack.callsTo("views.open")[0]!.args.trigger_id as string;
    expect(res.status).toBe(200);
    h.clock.set(h.clock.now() + 4000);
    const again = await h.ingress.slashCommand({ user: USERS.dana, channel: CHANNEL, text: "settings" });
    expect(again.status).toBe(200);
    expect(trigger).toBeTruthy();
  });
});

describe("capture by DMing the bot", () => {
  const dm = () => h.slack.im(USERS.dana).id;

  it("a top-level DM becomes a request that lives in a thread under that DM", async () => {
    const msg = await h.say({ channel: dm(), user: USERS.dana, text: "ask <@UBOB> to send the Q3 numbers by friday" });
    expect(h.queue.sentOfKind("extract")).toEqual([
      { kind: "extract", channelId: dm(), threadTs: null, messageTs: msg.ts, taggerId: USERS.dana, text: "ask <@UBOB> to send the Q3 numbers by friday", origin: "dm" },
    ]);
    h.anthropic.queueToolUse("record_asks", extractionInput({ requester: USERS.dana, owner: USERS.bob, asks: [{ title: "Send the Q3 numbers", source_ts: msg.ts }] }));
    await h.drain();
    const [req] = h.requests();
    expect(req).toMatchObject({ channel_id: dm(), thread_ts: msg.ts, status: "pending_confirmation", tagged_by_id: USERS.dana });
    const card = h.slack.message(dm(), req!.message_ts as string);
    expect(card.thread_ts).toBe(msg.ts);
    expect(flatText(card)).toContain("Send the Q3 numbers");

    // "yes" in that thread confirms, and the owner is told
    await h.say({ channel: dm(), user: USERS.dana, text: "yes", thread_ts: msg.ts });
    await h.drain();
    expect(h.requests()[0]!.status).toBe("confirmed");
    expect(h.slack.dmTexts(USERS.bob).join("\n")).toContain("Send the Q3 numbers");
    expect(h.errors).toEqual([]);
  });

  it("the bot's own messages, empty messages and thread replies in the DM are not captures", async () => {
    const root = await h.say({ channel: dm(), user: USERS.dana, text: "ask <@UBOB> to send the Q3 numbers" });
    const before = h.queue.sent.length;
    await h.say({ channel: dm(), user: USERS.dana, text: "   " });
    await h.say({ channel: dm(), user: USERS.dana, text: "a chatty reply", thread_ts: root.ts });
    expect(h.queue.sent.slice(before).filter((j) => j.kind === "extract")).toHaveLength(0);
    // a bot-authored event (what Slack sends for our own DMs)
    const bot = h.slack.addHumanMessage({ channel: dm(), user: USERS.dana, text: "x" });
    await h.ingress.event({ ...h.ingress.messageEvent({ channel: dm(), user: "UBOT", text: "Reading", ts: bot.ts }), bot_id: "BBOT" });
    expect(h.queue.sent.slice(before).filter((j) => j.kind === "extract")).toHaveLength(0);
  });
});
