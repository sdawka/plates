import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectUrl, decryptToken, disconnect, encryptToken, getUserToken, handleOAuth, signState, verifyState } from "../src/oauth";
import type { Env } from "../src/types";
import { asD1, makeDb, type FakeD1 } from "./helpers/fakeD1";

const KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)));
let fake: FakeD1;
let env: Env;
let calls: { url: string; init?: RequestInit }[];

function mockFetch(handler: (url: string, body: URLSearchParams) => unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(handler(url, new URLSearchParams(String(init?.body ?? "")))), { status: 200 });
    }),
  );
}

beforeEach(() => {
  fake = makeDb();
  calls = [];
  env = {
    DB: asD1(fake),
    SLACK_CLIENT_ID: "cid",
    SLACK_CLIENT_SECRET: "secret",
    TOKEN_ENC_KEY: KEY,
    PUBLIC_URL: "https://plates.example.dev",
    SLACK_BOT_TOKEN: "xoxb-bot",
  } as unknown as Env;
});
afterEach(() => vi.unstubAllGlobals());

describe("state", () => {
  it("round-trips a valid state", async () => {
    const s = await signState(KEY, "U1", 1000);
    expect(await verifyState(KEY, s, 2000)).toBe("U1");
  });
  it("rejects expired state", async () => {
    const s = await signState(KEY, "U1", 1000);
    expect(await verifyState(KEY, s, 1000 + 15 * 60 * 1000 + 1)).toBeNull();
  });
  it("rejects tampered payload, tampered signature and garbage", async () => {
    const s = await signState(KEY, "U1", 1000);
    const [p, sig] = s.split(".");
    const other = (await signState(KEY, "U2", 1000)).split(".")[0];
    expect(await verifyState(KEY, `${other}.${sig}`, 2000)).toBeNull();
    expect(await verifyState(KEY, `${p}.${sig!.slice(0, -2)}AA`, 2000)).toBeNull();
    expect(await verifyState(KEY, "nonsense", 2000)).toBeNull();
    expect(await verifyState(btoa("k".repeat(32)), s, 2000)).toBeNull();
  });
});

describe("token encryption", () => {
  it("round-trips and uses a fresh IV", async () => {
    const a = await encryptToken(KEY, "xoxp-secret");
    const b = await encryptToken(KEY, "xoxp-secret");
    expect(a).not.toBe(b);
    expect(a).not.toContain("xoxp");
    expect(await decryptToken(KEY, a)).toBe("xoxp-secret");
  });
});

describe("connectUrl / routing", () => {
  it("builds a link, or null when unconfigured", async () => {
    const url = await connectUrl(env, "U1");
    expect(url).toMatch(/^https:\/\/plates\.example\.dev\/oauth\/start\?state=/);
    expect(await connectUrl({ ...env, SLACK_CLIENT_ID: undefined }, "U1")).toBeNull();
  });
  it("404s when unconfigured", async () => {
    const res = await handleOAuth(new Request("https://x/oauth/start?state=a"), { ...env, TOKEN_ENC_KEY: undefined });
    expect(res.status).toBe(404);
  });
  it("start redirects to Slack with user scopes", async () => {
    const state = await signState(KEY, "U1");
    const res = await handleOAuth(new Request(`https://x/oauth/start?state=${encodeURIComponent(state)}`), env);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(loc.searchParams.get("client_id")).toBe("cid");
    expect(loc.searchParams.get("user_scope")).toBe("im:history,mpim:history,im:read,mpim:read");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://plates.example.dev/oauth/callback");
    expect(loc.searchParams.get("state")).toBe(state);
  });
  it("start rejects a bad state", async () => {
    expect((await handleOAuth(new Request("https://x/oauth/start?state=bad"), env)).status).toBe(400);
  });
});

describe("callback", () => {
  const access = (id = "U1") => ({
    // Documented shape when only user_scope was requested: no top-level bot token.
    ok: true,
    app_id: "A0KRD7HC3",
    team: { id: "T9TK3CUKW", name: "Team" },
    authed_user: { id, scope: "im:history,mpim:history,im:read,mpim:read", access_token: "xoxp-user", token_type: "user" },
  });
  const cb = async (userId = "U1") =>
    handleOAuth(new Request(`https://x/oauth/callback?code=abc&state=${encodeURIComponent(await signState(KEY, userId))}`), env);

  it("stores the encrypted user token", async () => {
    mockFetch(() => access());
    const res = await cb();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Plates can now read DMs you capture");
    const body = new URLSearchParams(String(calls[0]!.init!.body));
    expect(calls[0]!.url).toBe("https://slack.com/api/oauth.v2.access");
    expect(Object.fromEntries(body)).toMatchObject({ code: "abc", redirect_uri: "https://plates.example.dev/oauth/callback" });
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe(`Basic ${btoa("cid:secret")}`);
    const row = fake.all("SELECT * FROM user_tokens")[0]!;
    expect(row.user_id).toBe("U1");
    expect(row.token_enc).not.toContain("xoxp");
    expect(await getUserToken(env, "U1")).toBe("xoxp-user");
  });
  it("upserts on reconnect", async () => {
    mockFetch(() => access());
    await cb();
    await cb();
    expect(fake.all("SELECT * FROM user_tokens")).toHaveLength(1);
  });
  it("accepts a replayed state until expiry; Slack's single-use code is the real guard", async () => {
    const state = encodeURIComponent(await signState(KEY, "U1"));
    mockFetch(() => access());
    expect((await handleOAuth(new Request(`https://x/oauth/callback?code=a&state=${state}`), env)).status).toBe(200);
    mockFetch(() => ({ ok: false, error: "invalid_code" })); // Slack refuses the reused code
    expect((await handleOAuth(new Request(`https://x/oauth/callback?code=a&state=${state}`), env)).status).toBe(502);
    expect(await getUserToken(env, "U1")).toBe("xoxp-user"); // first token untouched
  });
  it("rejects a token for a different user", async () => {
    mockFetch(() => access("U_OTHER"));
    expect((await cb("U1")).status).toBe(403);
    expect(fake.all("SELECT * FROM user_tokens")).toHaveLength(0);
  });
  it("fails cleanly when Slack errors", async () => {
    mockFetch(() => ({ ok: false, error: "invalid_code" }));
    expect((await cb()).status).toBe(502);
  });
});

describe("disconnect", () => {
  it("revokes with the user token and deletes the row", async () => {
    mockFetch(() => ({ ok: true, authed_user: { id: "U1", access_token: "xoxp-user" } }));
    await (await import("../src/oauth")).handleOAuth(
      new Request(`https://x/oauth/callback?code=c&state=${encodeURIComponent(await signState(KEY, "U1"))}`),
      env,
    );
    calls = [];
    mockFetch(() => ({ ok: true, revoked: true }));
    await disconnect(env, "U1");
    expect(calls[0]!.url).toBe("https://slack.com/api/auth.revoke");
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer xoxp-user");
    expect(fake.all("SELECT * FROM user_tokens")).toHaveLength(0);
    expect(await getUserToken(env, "U1")).toBeNull();
  });
});
