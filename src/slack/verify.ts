// Slack request signature verification (HMAC-SHA256 over `v0:<ts>:<body>`), WebCrypto only.

const MAX_AGE_SECONDS = 5 * 60;
const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison (length is not secret). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signSlackBody(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(`v0:${timestamp}:${body}`));
  return `v0=${toHex(sig)}`;
}

export async function verifySlackSignature(opts: {
  secret: string;
  body: string;
  timestamp: string | null;
  signature: string | null;
  nowSeconds?: number;
}): Promise<boolean> {
  const { secret, body, timestamp, signature } = opts;
  if (!secret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > MAX_AGE_SECONDS) return false;
  return safeEqual(await signSlackBody(secret, timestamp, body), signature);
}
