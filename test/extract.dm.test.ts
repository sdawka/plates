import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleExtractJob } from "../src/extract";
import { encryptToken } from "../src/oauth";
import type { DraftAsk, Env, ExtractJob } from "../src/types";
import { asD1, makeDb, type FakeD1 } from "./helpers/fakeD1";

const llm = vi.hoisted(() => ({ prompts: [] as string[], result: null as unknown }));
vi.mock("../src/extract/llm", () => ({
  callExtraction: async (_env: unknown, prompt: string) => {
    llm.prompts.push(prompt);
    return llm.result;
  },
  callClarify: async () => null,
}));

const KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)));
const MSG = "1700000000.000100";

let fake: FakeD1;
let env: Env;
let calls: { method: string; token: string; form: Record<string, string> }[];
let botDmEmpty = true;
let isAsk = 0.9; // System One's answer to is_ask
let info: Record<string, unknown> | null = null;
let failFor: (method: string, token: string) => string | null;

beforeEach(() => {
  fake = makeDb();
  calls = [];
  botDmEmpty = true;
  isAsk = 0.9;
  info = null;
  llm.prompts = [];
  llm.result = {
    groups: [
      {
        requester_id: "U_OTHER",
        owner_id: "U_TAG",
        attribution_confidence: 0.9,
        attribution_reason: "other asked",
        asks: [{ title: "Send deck", type: "deliverable", size: "lt1h", urgency: "normal", estimate_reason: "x", owner_already_committed: false, source_ts: MSG }],
      },
    ],
  };
  failFor = (_m, token) => (token === "xoxb-bot" ? "not_in_channel" : null);
  env = { DB: asD1(fake), SLACK_BOT_TOKEN: "xoxb-bot", TOKEN_ENC_KEY: KEY, SLACK_CLIENT_ID: "c", SLACK_CLIENT_SECRET: "s", PUBLIC_URL: "https://p.dev" } as unknown as Env;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/v1/systemone")) return new Response(JSON.stringify({ answers: { is_ask: { type: "noul", noul: isAsk } } }));
      const method = url.split("/").pop()!;
      const token = String((init.headers as Record<string, string>).authorization).replace("Bearer ", "");
      const form = Object.fromEntries(new URLSearchParams(String(init.body)));
      calls.push({ method, token, form });
      const read = method === "conversations.history" || method === "conversations.replies";
      const err = read ? failFor(method, token) : null;
      let body: Record<string, unknown> = { ok: true };
      if (err) body = { ok: false, error: err };
      else if (method === "conversations.history" && form.channel === "D_BOT" && botDmEmpty) body = { ok: true, messages: [] };
      else if (method === "conversations.history") body = { ok: true, messages: [{ ts: MSG, user: "U_OTHER", text: "can you send the deck?" }] };
      else if (method === "conversations.info") body = info ? { ok: true, channel: info } : { ok: false, error: "channel_not_found" };
      else if (method === "users.info") body = { ok: true, user: { id: form.user, name: form.user, tz: "UTC" } };
      else if (method === "conversations.open") body = { ok: true, channel: { id: "D_BOT" } };
      else if (method === "chat.postMessage") body = { ok: true, ts: "1700000001.000200" };
      else if (method === "chat.getPermalink") body = { ok: true, permalink: "https://slack/archives/D1/p1" };
      return new Response(JSON.stringify(body));
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const job = (over: Partial<Extract<ExtractJob, { kind: "extract" }>> = {}): ExtractJob => ({
  kind: "extract",
  channelId: "D_SRC",
  threadTs: null,
  messageTs: MSG,
  taggerId: "U_TAG",
  text: "can you send the deck?",
  origin: "shortcut",
  sourceUserId: "U_OTHER",
  ...over,
});
const requests = () => fake.all("SELECT * FROM requests");
const posts = () => calls.filter((c) => c.method === "chat.postMessage");

describe("DM the bot can't read", () => {
  it("single-message path: anchors in the tagger's bot DM and sends the connect link", async () => {
    const effects = await handleExtractJob(env, job());
    const [req] = requests();
    expect(req).toMatchObject({ channel_id: "D_BOT", thread_ts: "1700000001.000200", tag_message_ts: MSG, tagged_by_id: "U_TAG" });
    expect(effects[0]).toMatchObject({ kind: "render_request", requestId: req!.id });
    expect(calls.find((c) => c.method === "conversations.open")!.form.users).toBe("U_TAG");
    expect(posts()[0]!.form.text).toBe("From your DM with <@U_OTHER>");
    expect(posts()[1]!.form).toMatchObject({ channel: "D_BOT" });
    expect(posts()[1]!.form.text).toMatch(/^I could only see the one message\. Connect Plates to read the whole DM: <https:\/\/p\.dev\/oauth\/start\?state=/);
    expect(llm.prompts[0]).toContain("Only this one message could be read");
    expect(calls.some((c) => c.token !== "xoxb-bot")).toBe(false);
  });

  it("skips the connect sentence when the feature is off", async () => {
    await handleExtractJob({ ...env, SLACK_CLIENT_ID: undefined }, job());
    expect(posts()).toHaveLength(1);
  });

  it("token path: reads with the user token and links the message", async () => {
    await fake.prepare("INSERT INTO user_tokens (user_id, token_enc, scopes, created_at) VALUES (?, ?, ?, ?)")
      .bind("U_TAG", await encryptToken(KEY, "xoxp-user"), "im:history", 1).run();
    await handleExtractJob(env, job());
    expect(calls.filter((c) => c.method === "conversations.history").map((c) => c.token)).toEqual(["xoxb-bot", "xoxp-user"]);
    expect(calls.filter((c) => c.method === "users.info").every((c) => c.token === "xoxb-bot")).toBe(true);
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.form.text).toBe("From your DM with <@U_OTHER>: https://slack/archives/D1/p1");
    expect(requests()[0]).toMatchObject({ channel_id: "D_BOT", thread_ts: "1700000001.000200" });
    expect(llm.prompts[0]).not.toContain("Only this one message");
  });

  it("uses conversations.info with the user token: private channel keeps the invite reply", async () => {
    await fake.prepare("INSERT INTO user_tokens (user_id, token_enc, scopes, created_at) VALUES (?, ?, ?, ?)")
      .bind("U_TAG", await encryptToken(KEY, "xoxp-user"), "im:history", 1).run();
    info = { is_channel: false, is_group: true, is_im: false, is_mpim: false, is_private: true };
    const effects = await handleExtractJob(env, job({ channelId: "G_PRIV" }));
    // The bot can't post in that channel, so the invite hint goes to the tagger's DM.
    expect(effects).toEqual([]);
    const hint = posts().at(-1)!;
    expect(hint.form.channel).toBe("U_TAG");
    expect(hint.form.text).toContain("/invite @plates");
    expect(requests()).toHaveLength(0);
    expect(calls.find((c) => c.method === "conversations.info")!.token).toBe("xoxp-user");
  });

  it("group DM with a C id is recognised by is_mpim", async () => {
    await fake.prepare("INSERT INTO user_tokens (user_id, token_enc, scopes, created_at) VALUES (?, ?, ?, ?) ")
      .bind("U_TAG", await encryptToken(KEY, "xoxp-user"), "im:history", 1).run();
    info = { is_mpim: true, is_private: true };
    await handleExtractJob(env, job({ channelId: "C_MPDM" }));
    expect(requests()).toHaveLength(1);
    expect(posts()[0]!.form.text).toBe("From a group DM: https://slack/archives/D1/p1");
  });

  it("without a token, the shortcut channel name decides", async () => {
    const mpdm = { ...job({ channelId: "C_MPDM" }), channelName: "mpdm-a--b--c-1" } as unknown as ExtractJob;
    await handleExtractJob(env, mpdm);
    expect(requests()).toHaveLength(1);
    const priv = { ...job({ channelId: "G_PRIV", messageTs: "1700000009.000100" }), channelName: "privategroup" } as unknown as ExtractJob;
    const effects = await handleExtractJob(env, priv);
    expect(effects).toEqual([]);
    expect(posts().at(-1)!.form.text).toContain("/invite @plates");
    expect(requests()).toHaveLength(1);
  });

  it("revoked token falls back to the single message", async () => {
    await fake.prepare("INSERT INTO user_tokens (user_id, token_enc, scopes, created_at) VALUES (?, ?, ?, ?)")
      .bind("U_TAG", await encryptToken(KEY, "xoxp-user"), "im:history", 1).run();
    failFor = (_m, t) => (t === "xoxb-bot" ? "not_in_channel" : "token_revoked");
    await handleExtractJob(env, job());
    expect(requests()).toHaveLength(1);
    expect(posts()[1]!.form.text).toContain("Connect Plates");
  });

  it("redelivery does not duplicate", async () => {
    await handleExtractJob(env, job());
    // Not posted yet (no dispatch here), so redelivery re-renders the same request instead of making a new one.
    const again = await handleExtractJob(env, job());
    expect(again).toEqual([{ kind: "render_request", requestId: requests()[0]!.id }]);
    expect(requests()).toHaveLength(1);
  });

  it("ordinary channel not_in_channel still asks for an invite", async () => {
    const effects = await handleExtractJob(env, job({ channelId: "C_PUB", origin: "mention" }));
    expect(effects).toEqual([{ kind: "thread_reply", channelId: "C_PUB", threadTs: MSG, text: expect.stringContaining("/invite @plates") }]);
    expect(requests()).toHaveLength(0);
  });
});

describe("origins", () => {
  it("dm origin marks the message as the primary ask", async () => {
    failFor = () => null;
    botDmEmpty = false;
    await handleExtractJob(env, job({ channelId: "D_BOT", origin: "dm", sourceUserId: undefined }));
    expect(llm.prompts[0]).toContain("sent you a direct message");
    expect(requests()[0]).toMatchObject({ channel_id: "D_BOT", thread_ts: MSG });
  });
  it("dm origin: a message that isn't an ask gets one hint and no extraction", async () => {
    failFor = () => null;
    botDmEmpty = false;
    isAsk = 0.29;
    const effects = await handleExtractJob(env, job({ channelId: "D_BOT", origin: "dm", sourceUserId: undefined, text: "hi, how are you?" }));
    expect(effects).toEqual([]);
    expect(llm.prompts).toHaveLength(0);
    expect(requests()).toHaveLength(0);
    const posts = calls.filter((c) => c.method === "chat.postMessage");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.form).toMatchObject({ channel: "D_BOT", text: expect.stringContaining("I track asks") });
  });
  it("dm origin: is_ask of 0.3 is enough to extract", async () => {
    failFor = () => null;
    botDmEmpty = false;
    isAsk = 0.3;
    await handleExtractJob(env, job({ channelId: "D_BOT", origin: "dm", sourceUserId: undefined }));
    expect(llm.prompts).toHaveLength(1);
  });
  it("only dm origin is filtered", async () => {
    failFor = () => null;
    isAsk = 0;
    await handleExtractJob(env, job({ channelId: "C1", origin: "command", threadTs: MSG }));
    expect(llm.prompts).toHaveLength(1);
  });
  it("command origin mentions the command text", async () => {
    failFor = () => null;
    await handleExtractJob(env, job({ channelId: "C1", origin: "command", threadTs: MSG }));
    expect(llm.prompts[0]).toContain("typed a /plates command");
  });
});

describe("correct for a DM-anchored request", () => {
  it("re-extracts from the stored draft without the original DM", async () => {
    await handleExtractJob(env, job());
    const req = requests()[0]!;
    const drafts = JSON.parse(String(req.draft_json)) as DraftAsk[];
    expect(drafts[0]!.source_ts).toBe(MSG);
    calls.length = 0;
    failFor = () => null;
    llm.prompts = [];
    await handleExtractJob(env, { kind: "correct", requestId: String(req.id), userId: "U_TAG", text: "make it urgent", messageTs: "1700000002.000300" });
    expect(llm.prompts[0]).toContain("original text no longer available; captured as: Send deck");
    expect(calls.some((c) => c.token !== "xoxb-bot")).toBe(false);
    expect(calls.every((c) => c.form.channel !== "D_SRC")).toBe(true);
  });
});
