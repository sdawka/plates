import { connectUrl } from "../oauth";
import { slackCall } from "../slack/api";
import type { DmAccess } from "../slack/dmaccess";
import type { Env } from "../types";
import { loadHomeData } from "./queries";
import { buildHomeView } from "./view";

export async function loadDmAccess(env: Env, userId: string): Promise<DmAccess> {
  const row = await env.DB.prepare("SELECT 1 AS x FROM user_tokens WHERE user_id = ?").bind(userId).first();
  return { connected: row !== null, connectUrl: row ? null : await connectUrl(env, userId) };
}

/** Build and views.publish the Home tab for one user. */
export async function publishHome(env: Env, userId: string): Promise<void> {
  const [data, dm] = await Promise.all([loadHomeData(env.DB, userId), loadDmAccess(env, userId).catch(() => undefined)]);
  data.dm = dm;
  const view = buildHomeView(data, userId, Date.now());
  await slackCall(env, "views.publish", { user_id: userId, view });
}
