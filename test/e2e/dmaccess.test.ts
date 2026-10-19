import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { USERS, createHarness, extractionInput, type Harness } from "../helpers/env";
import { flatText, interactiveElements } from "../helpers/fakeSlack";
import { decryptToken, signState } from "../../src/oauth";
import { TOKEN_ENC_KEY } from "../helpers/env";

let h: Harness;
beforeEach(() => void (h = createHarness()));
afterEach(() => h.dispose());

const USER_SCOPES = ["im:history", "mpim:history", "im:read", "mpim:read"];
const CALLBACK = "https://plates.test/oauth/callback";
const get = (url: string) => h.fetch(new Request(url));

const connectButton = (user: string) =>
  interactiveElements(h.slack.homeViews.get(user)?.blocks).find((e) => e.element.action_id === "oauth:connect")?.element as { url?: string } | undefined;
const tokenRows = () => h.q("SELECT user_id, token_enc, scopes FROM user_tokens");

/** Home -> "Connect DMs" -> /oauth/start -> Slack -> /oauth/callback, as the user's browser would. */
async function connect(user: string): Promise<string> {
  await h.openHome(user);
  const start = await get(connectButton(user)!.url!);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const code = h.slack.issueOAuthCode({ userId: user, userScopes: USER_SCOPES, redirectUri: CALLBACK });
  const done = await get(`${CALLBACK}?code=${code}&state=${encodeURIComponent(state)}`);
  expect(done.status).toBe(200);
  return (await decryptToken(TOKEN_ENC_KEY, tokenRows().find((r) => r.user_id === user)!.token_enc as string));
}

describe("OAuth: connecting DM access", () => {
  it("Home offers a connect link that redirects to Slack's authorize page with the user scopes", async () => {
    await h.openHome(USERS.dana);
    const url = connectButton(USERS.dana)?.url;
    expect(url).toMatch(/^https:\/\/plates\.test\/oauth\/start\?state=/);
    const res = await get(url!);
    expect(res.status).toBe(302);
    const dest = new URL(res.headers.get("location")!);
    expect(`${dest.origin}${dest.pathname}`).toBe("https://slack.com/oauth/v2/authorize");
    expect(dest.searchParams.get("client_id")).toBe("111.222");
    expect(dest.searchParams.get("user_scope")).toBe(USER_SCOPES.join(","));
    expect(dest.searchParams.get("scope")).toBeNull(); // user-only install: no bot scopes requested
    expect(dest.searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(dest.searchParams.get("state")).toBeTruthy();
  });

  it("the callback exchanges the code (client credentials in Basic auth), stores the token encrypted, and Home flips to Disconnect", async () => {
    const token = await connect(USERS.dana);
    expect(token).toMatch(/^xoxp-UDANA-/);
    const [row] = tokenRows();
    expect(row).toMatchObject({ user_id: USERS.dana, scopes: USER_SCOPES.join(",") });
    expect(String(row!.token_enc)).not.toContain("xoxp");
    expect(JSON.stringify(h.q("SELECT * FROM user_tokens"))).not.toContain(token);

    const exchange = h.slack.callsTo("oauth.v2.access")[0]!;
    expect(exchange).toMatchObject({ ok: true, args: { redirect_uri: CALLBACK } });
    expect(exchange.args.client_secret).toBeUndefined();

    await h.openHome(USERS.dana);
    const ids = interactiveElements(h.slack.homeViews.get(USERS.dana)!.blocks).map((e) => e.element.action_id);
    expect(ids).toContain("oauth:disconnect");
    expect(ids).not.toContain("oauth:connect");
    expect(h.errors).toEqual([]);
  });

  it("Disconnect from Home revokes the token at Slack, forgets it, and offers Connect again", async () => {
    const token = await connect(USERS.dana);
    await h.openHome(USERS.dana);
    expect((await h.clickHome(USERS.dana, "oauth:disconnect", "disconnect")).status).toBe(200);
    expect(tokenRows()).toEqual([]);
    expect(h.slack.callsTo("auth.revoke")).toHaveLength(1);
    expect(h.slack.callsTo("auth.revoke")[0]).toMatchObject({ token, ok: true, response: { revoked: true } });
    expect(h.slack.tokens.has(token)).toBe(false);
    expect(connectButton(USERS.dana)).toBeTruthy();
    expect(h.errors).toEqual([]);
  });

  it("rejects a tampered state, an expired link, a denied grant, another user's code and a replayed code", async () => {
    const good = await signState(TOKEN_ENC_KEY, USERS.dana, h.clock.now());
    const cb = (q: Record<string, string>) => get(`${CALLBACK}?${new URLSearchParams(q)}`);
    const code = (u: string) => h.slack.issueOAuthCode({ userId: u, userScopes: USER_SCOPES, redirectUri: CALLBACK });

    expect((await cb({ code: code(USERS.dana), state: good.slice(0, -2) + "xx" })).status).toBe(400);
    expect((await get(`https://plates.test/oauth/start?state=garbage`)).status).toBe(400);
    expect((await cb({ error: "access_denied", state: good })).status).toBe(400);
    expect((await cb({ code: code(USERS.eve), state: good })).status).toBe(403); // eve's grant on dana's link
    expect(tokenRows()).toEqual([]);

    const c = code(USERS.dana);
    expect((await cb({ code: c, state: good })).status).toBe(200);
    expect((await cb({ code: c, state: good })).status).toBe(502); // code_already_used at Slack
    expect(tokenRows()).toHaveLength(1);

    h.clock.set(h.clock.now() + 16 * 60_000);
    expect((await cb({ code: code(USERS.dana), state: good })).status).toBe(400);
  });

  it("reconnecting replaces the stored token rather than adding a second row", async () => {
    await connect(USERS.dana);
    // Slack lets a user re-authorize from an old link (the state stays valid for 15 minutes).
    const state = await signState(TOKEN_ENC_KEY, USERS.dana, h.clock.now());
    const code = h.slack.issueOAuthCode({ userId: USERS.dana, userScopes: USER_SCOPES, redirectUri: CALLBACK });
    expect((await get(`${CALLBACK}?code=${code}&state=${encodeURIComponent(state)}`)).status).toBe(200);
    const second = [...h.slack.tokens.keys()].filter((t) => t.startsWith("xoxp-UDANA")).at(-1)!;
    expect(tokenRows()).toHaveLength(1);
    expect(await decryptToken(TOKEN_ENC_KEY, tokenRows()[0]!.token_enc as string)).toBe(second);
  });
});

describe("message shortcut from a DM the bot is not in", () => {
  const DM = "D900";
  const dmText = "can you send the Q3 numbers by Friday?";

  async function shortcut() {
    h.slack.addDirect(DM, USERS.dana, USERS.bob);
    const msg = h.slack.addHumanMessage({ channel: DM, user: USERS.bob, text: "hey" });
    const ask = h.slack.addHumanMessage({ channel: DM, user: USERS.dana, text: dmText });
    const res = await h.ingress.interaction(h.ingress.messageAction({ user: USERS.dana, callbackId: "plates_capture", channel: DM, ts: ask.ts }));
    expect(res.status).toBe(200);
    return { msg, ask };
  }
  const botDm = () => h.slack.im(USERS.dana);

  it("with a user token: reads the DM, and the request lives in the bot DM, anchored to a link back", async () => {
    const token = await connect(USERS.dana);
    h.slack.clearCalls();
    const { msg, ask } = await shortcut();
    expect(h.queue.sentOfKind("extract")[0]).toMatchObject({ origin: "shortcut", channelId: DM, messageTs: ask.ts, taggerId: USERS.dana, sourceUserId: USERS.dana, channelName: "directmessage" });

    h.anthropic.queueToolUse("record_asks", extractionInput({ requester: USERS.dana, owner: USERS.bob, asks: [{ title: "Send the Q3 numbers", source_ts: ask.ts }] }));
    await h.drain();

    // the DM was read with the user's token, never the bot's
    const reads = h.slack.calls.filter((c) => ["conversations.history", "conversations.replies"].includes(c.method) && c.args.channel === DM);
    const withToken = reads.filter((c) => c.token === token);
    expect(withToken.length).toBeGreaterThan(0);
    expect(withToken.every((c) => c.ok)).toBe(true);
    // the bot's own first attempt is refused (it is not in that DM) and leaks nothing
    expect(reads.filter((c) => c.token !== token).every((c) => !c.ok && c.error === "channel_not_found")).toBe(true);
    expect(h.slack.calls.filter((c) => c.args.channel === DM && c.token !== token && c.ok)).toEqual([]);
    expect(h.anthropic.requests[0]!.prompt).toContain(msg.ts);
    expect(h.anthropic.requests[0]!.prompt).toContain(`"hey"`);

    const [req] = h.requests();
    expect(req).toMatchObject({ channel_id: botDm().id, status: "pending_confirmation", requester_id: USERS.dana, owner_id: USERS.bob });
    const anchor = botDm().messages.find((m) => m.ts === req!.thread_ts)!;
    expect(anchor.text).toMatch(/^From your DM: https:\/\/plates-test\.slack\.com\//);
    expect(botDm().messages.map((m) => m.text).join("\n")).not.toContain("Connect Plates");
    expect(h.errors).toEqual([]);
  });

  it("without a token: sees only the one message, still makes the request in the bot DM, and offers the connect link", async () => {
    const { ask } = await shortcut();
    h.anthropic.queueToolUse("record_asks", extractionInput({ requester: USERS.dana, owner: USERS.bob, asks: [{ title: "Send the Q3 numbers", source_ts: ask.ts }] }));
    await h.drain();

    expect(h.slack.calls.filter((c) => c.args.channel === DM && c.ok)).toEqual([]); // nothing in that DM was readable or writable
    expect(h.anthropic.requests[0]!.prompt).toContain(dmText);
    const [req] = h.requests();
    expect(req).toMatchObject({ channel_id: botDm().id, status: "pending_confirmation" });
    expect(flatText(h.slack.message(botDm().id, req!.message_ts as string))).toContain("Send the Q3 numbers");
    const hint = botDm().messages.find((m) => m.text.includes("could only see the one message"))!;
    expect(hint.thread_ts).toBeUndefined();
    const url = /<(https:\/\/plates\.test\/oauth\/start\?state=[^>]+)>/.exec(hint.text)![1]!;
    expect((await get(url)).status).toBe(302);
    expect(h.errors).toEqual([]);
  });

  it("tells the person who can confirm by DM, since only the tagger sees the bot-DM confirmation", async () => {
    await connect(USERS.dana); // so the whole DM, and with it Bob, is visible
    await shortcut(); // Dana (requester) captures her own ask to Bob
    h.anthropic.queueToolUse("record_asks", extractionInput({ requester: USERS.dana, owner: USERS.bob, asks: [{ title: "Send the Q3 numbers", source_ts: h.slack.channel(DM).messages.at(-1)!.ts }] }));
    await h.drain();
    const [req] = h.requests();
    const toBob = h.slack.im(USERS.bob).messages;
    expect(toBob).toHaveLength(1);
    expect(flatText(toBob[0]!)).toContain("Send the Q3 numbers");
    expect(interactiveElements(toBob[0]!.blocks).map((e) => e.element.action_id)).toEqual(["req:confirm", "req:edit"]);
    // Dana tagged it herself, so she only has the confirmation in her own bot DM.
    expect(botDm().messages.filter((m) => m.text.includes("needs your confirmation"))).toEqual([]);

    await h.click(USERS.bob, { channel: h.slack.im(USERS.bob).id, ts: toBob[0]!.ts }, "req:confirm", req!.id as string);
    expect(h.requests()[0]!.status).toBe("confirmed");
    expect(h.errors).toEqual([]);
  });

  it("group DM captured by a third party: requester and owner each get the confirm DM, the tagger doesn't", async () => {
    const G = "G777";
    h.slack.addGroupDm(G, [USERS.dana, USERS.bob, USERS.tara]);
    const ask = h.slack.addHumanMessage({ channel: G, user: USERS.dana, text: `<@${USERS.bob}> can you review the deck?` });
    await h.ingress.interaction(h.ingress.messageAction({ user: USERS.tara, callbackId: "plates_capture", channel: G, ts: ask.ts }));
    h.anthropic.queueToolUse("record_asks", extractionInput({ requester: USERS.dana, owner: USERS.bob, asks: [{ title: "Review the deck", source_ts: ask.ts }] }));
    await h.drain();

    const [req] = h.requests();
    expect(req).toMatchObject({ channel_id: h.slack.im(USERS.tara).id, tagged_by_id: USERS.tara, status: "pending_confirmation" });
    for (const user of [USERS.dana, USERS.bob]) {
      const dms = h.slack.im(user).messages;
      expect(dms, user).toHaveLength(1);
      expect(flatText(dms[0]!)).toContain(`<@${USERS.tara}> captured this from a DM`);
      expect(flatText(dms[0]!)).toContain("Review the deck");
    }
    expect(flatText(h.slack.im(USERS.dana).messages[0]!)).toContain(`Only you or <@${USERS.bob}> can confirm`);
    expect(h.slack.im(USERS.tara).messages.some((m) => m.text.includes("needs your confirmation"))).toBe(false);

    const danaDm = h.slack.im(USERS.dana);
    await h.click(USERS.dana, { channel: danaDm.id, ts: danaDm.messages[0]!.ts }, "req:confirm", req!.id as string);
    expect(h.requests()[0]!.status).toBe("confirmed");
    expect(h.errors).toEqual([]);
  });

  it("a revoked user token degrades to the single message instead of failing the job", async () => {
    const token = await connect(USERS.dana);
    h.slack.tokens.delete(token); // revoked at Slack behind our back
    const { ask } = await shortcut();
    h.anthropic.queueToolUse("record_asks", extractionInput({ requester: USERS.dana, owner: USERS.bob, asks: [{ title: "Send the Q3 numbers", source_ts: ask.ts }] }));
    const r = await h.drain();
    expect(r.retried).toEqual([]);
    expect(h.requests()).toHaveLength(1);
  });

  it("a channel the bot cannot read and that is not a DM gets a private invite hint", async () => {
    h.slack.addChannel("C300", { name: "secret-proj", members: [USERS.dana], botIn: false });
    const m = h.slack.addHumanMessage({ channel: "C300", user: USERS.dana, text: "do the thing" });
    await h.ingress.interaction(h.ingress.messageAction({ user: USERS.dana, callbackId: "plates_capture", channel: "C300", ts: m.ts }));
    await h.drain();
    expect(h.requests()).toHaveLength(0);
    expect(h.slack.dmTexts(USERS.dana).join("\n")).toContain("/invite @plates");
  });

  it("the shortcut on a channel message the bot is in works like an @plates tag", async () => {
    const root = await h.say({ user: USERS.dana, text: `<@${USERS.bob}> please send the Q3 numbers` });
    await h.ingress.interaction(h.ingress.messageAction({ user: USERS.tara, callbackId: "plates_capture", channel: "C100", ts: root.ts }));
    h.anthropic.queueToolUse("record_asks", extractionInput({ requester: USERS.dana, owner: USERS.bob, asks: [{ title: "Send the Q3 numbers", source_ts: root.ts }] }));
    await h.drain();
    expect(h.requests()[0]).toMatchObject({ channel_id: "C100", tagged_by_id: USERS.tara, status: "pending_confirmation" });
  });
});
