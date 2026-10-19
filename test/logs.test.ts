import { beforeEach, describe, expect, it } from "vitest";
import { FakeD1 } from "./helpers/fakeD1";
import { resetKeyCache, verifyAccess } from "../logs/src/access";
import { toRow, worthKeeping, type TailItem } from "../logs/src/ingest";
import { handleFetch, queryLogs, storeRows, type LogsEnv } from "../logs/src/index";

const T = 1_792_400_000_000;
const item = (o: Partial<TailItem>): TailItem => ({ eventTimestamp: T, outcome: "ok", event: null, logs: [], exceptions: [], ...o });
const fetchEvent = (method: string, url: string, status = 200) => ({ request: { method, url, headers: {} }, response: { status } });
const log = (level: string, ...message: unknown[]) => ({ timestamp: T + 5, level, message });

describe("tail events become rows", () => {
  it("names a Slack event from Plates' info line", () => {
    const r = toRow(item({
      event: fetchEvent("POST", "https://plates.example/slack/events"),
      logs: [log("log", JSON.stringify({ msg: "slack event", type: "app_mention", user: "UDANA" })), log("log", JSON.stringify({ msg: "llm call", ms: 900 }))],
      wallTime: 1200,
    }));
    expect(r).toMatchObject({ kind: "fetch", summary: "slack event app_mention · 200 · 1 model call", level: "info", wall_ms: 1200 });
  });

  it("an exception or a failed outcome is an error, a warning is a warning", () => {
    expect(toRow(item({ exceptions: [{ timestamp: T, name: "TypeError", message: "x is undefined" }] })).level).toBe("error");
    expect(toRow(item({ outcome: "exceededCpu" })).level).toBe("error");
    expect(toRow(item({ logs: [log("warn", "slow")] })).level).toBe("warn");
  });

  it("summarizes queue batches by job, and keeps lines in time order", () => {
    const r = toRow(item({
      event: { queue: "plates-extract", batchSize: 2 },
      logs: [
        { timestamp: T + 9, level: "log", message: [JSON.stringify({ msg: "job", kind: "intent", attempt: 2 })] },
        { timestamp: T + 1, level: "log", message: [JSON.stringify({ msg: "job", kind: "extract", attempt: 1 })] },
      ],
    }));
    expect(r.summary).toBe("queue: extract, intent (try 2)");
    expect(r.lines.map((l) => l.t)).toEqual([T + 1, T + 9]);
  });

  it("drops quiet GETs and keeps everything else", () => {
    expect(worthKeeping(toRow(item({ event: fetchEvent("GET", "https://plates.example/") })))).toBe(false);
    expect(worthKeeping(toRow(item({ event: fetchEvent("GET", "https://plates.example/oauth/callback"), logs: [log("error", "bad state")] })))).toBe(true);
    expect(worthKeeping(toRow(item({ event: { scheduledTime: T } })))).toBe(true);
  });
});

// ---------- Access ----------

const TEAM = "https://webisoft.cloudflareaccess.com";
const AUD = "aud-123";
let signKey: CryptoKey;
let jwk: JsonWebKey & { kid: string };

const b64url = (b: Uint8Array | string) =>
  btoa(typeof b === "string" ? b : String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function token(claims: Record<string, unknown>, o: { kid?: string; key?: CryptoKey } = {}): Promise<string> {
  const h = b64url(JSON.stringify({ alg: "RS256", kid: o.kid ?? jwk.kid, typ: "JWT" }));
  const p = b64url(JSON.stringify({ aud: [AUD], iss: TEAM, email: "sahil@webisoft.com", exp: Math.floor(Date.now() / 1000) + 600, ...claims }));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", o.key ?? signKey, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${b64url(sig)}`;
}

const certs: typeof fetch = async (input) => {
  expect(String(input)).toBe(`${TEAM}/cdn-cgi/access/certs`);
  return new Response(JSON.stringify({ keys: [jwk] }));
};
const req = (t?: string, path = "/") => new Request(`https://plates-logs.example${path}`, { headers: t ? { "cf-access-jwt-assertion": t } : {} });

beforeEach(async () => {
  resetKeyCache();
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  signKey = pair.privateKey;
  jwk = { ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey), kid: "k1" };
});

describe("Cloudflare Access", () => {
  const cfg = { teamDomain: TEAM, aud: AUD };

  it("accepts a valid token and returns the email", async () => {
    expect(await verifyAccess(req(await token({})), cfg, certs)).toEqual({ email: "sahil@webisoft.com" });
  });

  it("rejects a missing, expired, wrong-app, wrong-issuer or forged token", async () => {
    const other = ((await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair).privateKey;
    expect(await verifyAccess(req(), cfg, certs)).toBeNull();
    expect(await verifyAccess(req(await token({ exp: Math.floor(Date.now() / 1000) - 5 })), cfg, certs)).toBeNull();
    expect(await verifyAccess(req(await token({ aud: ["someone-else"] })), cfg, certs)).toBeNull();
    expect(await verifyAccess(req(await token({ iss: "https://evil.cloudflareaccess.com" })), cfg, certs)).toBeNull();
    expect(await verifyAccess(req(await token({}, { key: other })), cfg, certs)).toBeNull();
    expect(await verifyAccess(req(await token({}, { kid: "unknown" })), cfg, certs)).toBeNull();
    expect(await verifyAccess(req("not.a.jwt"), cfg, certs)).toBeNull();
  });

  it("is closed until configured", async () => {
    expect(await verifyAccess(req(await token({})), {}, certs)).toBeNull();
  });
});

// ---------- the app ----------

describe("pages", () => {
  const LOGS_DIR = new URL("../logs/migrations/", import.meta.url);
  const env = (over: Partial<LogsEnv> = {}): LogsEnv => ({
    LOGS: new FakeD1(LOGS_DIR) as unknown as D1Database,
    APP: new FakeD1() as unknown as D1Database,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ...over,
  });

  it("is locked without Access configured, and forbidden without a token", async () => {
    const locked = await handleFetch(req(await token({})), env({ ACCESS_AUD: "" }), certs);
    expect(locked.status).toBe(403);
    expect(await locked.text()).toContain("Cloudflare Access");
    expect((await handleFetch(req(), env(), certs)).status).toBe(403);
  });

  it("lists stored logs newest first, filters, and escapes what Slack users wrote", async () => {
    const e = env();
    await storeRows(e.LOGS, [
      toRow(item({ eventTimestamp: T, event: fetchEvent("POST", "https://p/slack/events"), logs: [log("log", JSON.stringify({ msg: "slack event", type: "message" }))] })),
      toRow(item({ eventTimestamp: T + 1000, event: { queue: "plates-extract", batchSize: 1 }, exceptions: [{ timestamp: T + 1001, name: "Error", message: "<script>alert(1)</script>" }] })),
    ]);
    const res = await handleFetch(req(await token({})), e, certs);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const body = await res.text();
    expect(body).toContain("sahil@webisoft.com");
    expect(body.indexOf("queue plates-extract")).toBeLessThan(body.indexOf("slack event message"));
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");

    const errors = await queryLogs(e.LOGS, { level: "error", kind: "all", q: "", before: null });
    expect(errors.rows.map((r) => r.kind)).toEqual(["queue"]);
    const found = await queryLogs(e.LOGS, { level: "all", kind: "all", q: "SLACK EVENT", before: null });
    expect(found.rows.map((r) => r.kind)).toEqual(["fetch"]);
    const literal = await queryLogs(e.LOGS, { level: "all", kind: "all", q: "%", before: null });
    expect(literal.rows).toHaveLength(0);
  });

  it("shows requests and one request's asks and history", async () => {
    const e = env();
    const app = e.APP as unknown as FakeD1;
    app.sqlite.exec(`INSERT INTO requests (id, channel_id, thread_ts, status, tagged_by_id, requester_id, owner_id, attribution_confidence, draft_json, created_at, updated_at)
      VALUES ('r1', 'C1', '1.0', 'confirmed', 'UTARA', 'UDANA', 'UBOB', 0.9, '[{"title":"Send the Q3 numbers","source_ts":"1.0"}]', ${T}, ${T})`);
    app.sqlite.exec(`INSERT INTO asks (id, request_id, requester_id, owner_id, holder_id, title, type, state, size, urgency, created_at, updated_at)
      VALUES ('a1', 'r1', 'UDANA', 'UBOB', 'UBOB', 'Send the Q3 numbers', 'deliverable', 'in_progress', 'hours', 'normal', ${T}, ${T})`);
    app.sqlite.exec(`INSERT INTO ask_events (id, ask_id, request_id, actor_id, kind, from_state, to_state, via, at)
      VALUES ('e1', 'a1', 'r1', 'UBOB', 'accept_now', 'proposed', 'in_progress', 'dm', ${T + 5})`);
    const t = await token({});
    const list = await (await handleFetch(req(t, "/requests"), e, certs)).text();
    expect(list).toContain("Send the Q3 numbers");
    expect(list).toContain('href="/requests/r1"');
    const detail = await (await handleFetch(req(t, "/requests/r1"), e, certs)).text();
    expect(detail).toContain("accept_now");
    expect(detail).toContain("proposed → in_progress");
    expect((await handleFetch(req(t, "/requests/nope"), e, certs)).status).toBe(404);
  });
});
