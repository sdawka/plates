// Opt-in Slack user token (OAuth v2) so Plates can read DMs the bot isn't in.
// GET /oauth/start?state=… → Slack authorize; GET /oauth/callback?code&state → store the encrypted token.

import { slackCall } from "../slack/api";
import type { Env } from "../types";

// *:read lets conversations.info tell a DM from a private channel.
export const USER_SCOPES = "im:history,mpim:history,im:read,mpim:read";
const STATE_TTL_MS = 15 * 60 * 1000;
const enc = new TextEncoder();

type OAuthEnv = Env & { SLACK_CLIENT_ID: string; SLACK_CLIENT_SECRET: string; TOKEN_ENC_KEY: string; PUBLIC_URL: string };

function configured(env: Env): env is OAuthEnv {
  return !!(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET && env.TOKEN_ENC_KEY && env.PUBLIC_URL);
}

// ---------- encoding ----------

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const b64url = (bytes: Uint8Array) => b64encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlDecode = (s: string) => b64decode(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));

// ---------- state ----------

async function stateKey(keyB64: string): Promise<CryptoKey> {
  const root = await crypto.subtle.importKey("raw", b64decode(keyB64), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", root, enc.encode("plates-oauth-state"));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** state = base64url("userId.expiryMs") + "." + base64url(HMAC). */
export async function signState(keyB64: string, userId: string, now = Date.now()): Promise<string> {
  const payload = b64url(enc.encode(`${userId}.${now + STATE_TTL_MS}`));
  const sig = await crypto.subtle.sign("HMAC", await stateKey(keyB64), enc.encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

/** Returns the user id, or null when the state is malformed, tampered with or expired. */
export async function verifyState(keyB64: string, state: string, now = Date.now()): Promise<string | null> {
  const [payload, sig, extra] = state.split(".");
  if (!payload || !sig || extra !== undefined) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await stateKey(keyB64), b64urlDecode(sig), enc.encode(payload)); // constant time
    if (!ok) return null;
    const text = new TextDecoder().decode(b64urlDecode(payload));
    const dot = text.lastIndexOf(".");
    const expiry = Number(text.slice(dot + 1));
    if (dot < 1 || !Number.isFinite(expiry) || expiry < now) return null;
    return text.slice(0, dot);
  } catch {
    return null;
  }
}

// ---------- token encryption ----------

async function aesKey(keyB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", b64decode(keyB64), "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** base64(iv ‖ ciphertext) with a random 12-byte IV. */
export async function encryptToken(keyB64: string, token: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(keyB64), enc.encode(token)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64encode(out);
}

export async function decryptToken(keyB64: string, blob: string): Promise<string> {
  const raw = b64decode(blob);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, await aesKey(keyB64), raw.slice(12));
  return new TextDecoder().decode(pt);
}

// ---------- public API ----------

/** Link the user opens to connect their account; null when the feature isn't configured. */
export async function connectUrl(env: Env, userId: string): Promise<string | null> {
  if (!configured(env)) return null;
  return `${env.PUBLIC_URL.replace(/\/+$/, "")}/oauth/start?state=${encodeURIComponent(await signState(env.TOKEN_ENC_KEY, userId))}`;
}

export async function getUserToken(env: Env, userId: string): Promise<string | null> {
  if (!env.TOKEN_ENC_KEY) return null;
  const row = await env.DB.prepare("SELECT token_enc FROM user_tokens WHERE user_id = ?").bind(userId).first<{ token_enc: string }>();
  if (!row) return null;
  try {
    return await decryptToken(env.TOKEN_ENC_KEY, row.token_enc);
  } catch {
    return null;
  }
}

/** Revoke the user's token at Slack (best effort) and forget it. */
export async function disconnect(env: Env, userId: string): Promise<void> {
  const token = await getUserToken(env, userId);
  if (token) {
    try {
      await slackCall({ ...env, SLACK_BOT_TOKEN: token }, "auth.revoke", {});
    } catch {
      // Already revoked or invalid: the row goes either way.
    }
  }
  await env.DB.prepare("DELETE FROM user_tokens WHERE user_id = ?").bind(userId).run();
}

// ---------- routes ----------
// A state stays valid for its 15 minutes after use. Replaying it is harmless: the code is single-use at Slack,
// and the callback only stores a token Slack issued for the same user the state names.

function page(status: number, message: string): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Plates</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><p>${message}</p></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

interface OAuthAccess {
  ok: boolean;
  error?: string;
  authed_user?: { id?: string; scope?: string; access_token?: string; token_type?: string };
}

export async function handleOAuth(req: Request, env: Env): Promise<Response> {
  if (!configured(env) || req.method !== "GET") return new Response("not found", { status: 404 });
  const url = new URL(req.url);
  const state = url.searchParams.get("state") ?? "";

  if (url.pathname === "/oauth/start") {
    if (!(await verifyState(env.TOKEN_ENC_KEY, state))) return page(400, "This link has expired. Ask Plates for a new one.");
    const dest = new URL("https://slack.com/oauth/v2/authorize");
    dest.searchParams.set("client_id", env.SLACK_CLIENT_ID);
    dest.searchParams.set("user_scope", USER_SCOPES);
    dest.searchParams.set("redirect_uri", `${env.PUBLIC_URL.replace(/\/+$/, "")}/oauth/callback`);
    dest.searchParams.set("state", state);
    return Response.redirect(dest.toString(), 302);
  }

  if (url.pathname === "/oauth/callback") {
    const userId = await verifyState(env.TOKEN_ENC_KEY, state);
    if (!userId) return page(400, "This link has expired. Ask Plates for a new one.");
    if (url.searchParams.get("error")) return page(400, "Slack access was not granted, so nothing was connected.");
    const code = url.searchParams.get("code");
    if (!code) return page(400, "Missing authorization code.");

    const res = await fetch(`${env.SLACK_API_URL ?? "https://slack.com/api"}/oauth.v2.access`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        // Slack prefers HTTP Basic for the client credentials.
        authorization: `Basic ${btoa(`${env.SLACK_CLIENT_ID}:${env.SLACK_CLIENT_SECRET}`)}`,
      },
      body: new URLSearchParams({
        code,
        redirect_uri: `${env.PUBLIC_URL.replace(/\/+$/, "")}/oauth/callback`,
      }).toString(),
    });
    const json = (await res.json().catch(() => ({ ok: false }))) as OAuthAccess;
    const authed = json.authed_user;
    if (!json.ok || !authed?.access_token || !authed.id) return page(502, "Slack did not complete the connection. Please try again.");
    if (authed.id !== userId) return page(403, "That Slack account doesn't match the one this link was made for.");

    await env.DB
      .prepare(
        "INSERT INTO user_tokens (user_id, token_enc, scopes, created_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(user_id) DO UPDATE SET token_enc = excluded.token_enc, scopes = excluded.scopes, created_at = excluded.created_at",
      )
      .bind(userId, await encryptToken(env.TOKEN_ENC_KEY, authed.access_token), authed.scope ?? USER_SCOPES, Date.now())
      .run();
    return page(200, "Plates can now read DMs you capture. You can close this tab.");
  }

  return new Response("not found", { status: 404 });
}
