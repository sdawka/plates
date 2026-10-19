// STUB — Phase 3 opt-in user token flow (GET /oauth/start, GET /oauth/callback).
import type { Env } from "../types";

export async function handleOAuth(req: Request, env: Env): Promise<Response> {
  return new Response("not found", { status: 404 });
}
