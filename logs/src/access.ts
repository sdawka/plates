// Cloudflare Access: every request must carry a valid Access JWT for this application.
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
// Fails closed: without ACCESS_TEAM_DOMAIN and ACCESS_AUD nothing is served.

export interface AccessConfig {
  /** e.g. https://example.cloudflareaccess.com */
  teamDomain?: string;
  /** The application's Audience (AUD) tag. */
  aud?: string;
}

export interface AccessUser {
  email: string;
}

type Jwk = JsonWebKey & { kid?: string };
let cache: { url: string; keys: Jwk[]; at: number } | null = null;
const KEY_TTL_MS = 10 * 60_000;

const b64url = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};
const json = (s: string): Record<string, unknown> => JSON.parse(new TextDecoder().decode(b64url(s))) as Record<string, unknown>;

async function keys(certsUrl: string, fetcher: typeof fetch, refresh = false): Promise<Jwk[]> {
  if (!refresh && cache && cache.url === certsUrl && Date.now() - cache.at < KEY_TTL_MS) return cache.keys;
  const res = await fetcher(certsUrl);
  if (!res.ok) throw new Error(`access certs ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  cache = { url: certsUrl, keys: body.keys ?? [], at: Date.now() };
  return cache.keys;
}

export const isConfigured = (c: AccessConfig): boolean => !!c.teamDomain && !!c.aud;

/** The signed-in user, or null when the token is missing, forged, expired or for another app. */
export async function verifyAccess(req: Request, c: AccessConfig, fetcher: typeof fetch = fetch, now = Date.now()): Promise<AccessUser | null> {
  if (!isConfigured(c)) return null;
  const token = req.headers.get("cf-access-jwt-assertion");
  if (!token) return null;
  const [h, p, sig] = token.split(".");
  if (!h || !p || !sig) return null;
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = json(h);
    payload = json(p);
  } catch {
    return null;
  }
  if (header.alg !== "RS256") return null;

  const team = c.teamDomain!.replace(/\/+$/, "");
  const certsUrl = `${team}/cdn-cgi/access/certs`;
  let jwk = (await keys(certsUrl, fetcher)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await keys(certsUrl, fetcher, true)).find((k) => k.kid === header.kid); // keys rotate
  if (!jwk) return null;

  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) return null;

  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(c.aud)) return null;
  if (payload.iss !== team) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 < now) return null;
  if (typeof payload.nbf === "number" && payload.nbf * 1000 > now + 60_000) return null;
  return { email: typeof payload.email === "string" ? payload.email : "service token" };
}

/** For tests. */
export function resetKeyCache(): void {
  cache = null;
}
