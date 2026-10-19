import { slackCall } from "../slack/api";
import type { Env } from "../types";
import { loadHomeData } from "./queries";
import { buildHomeView } from "./view";

/** Build and views.publish the Home tab for one user. */
export async function publishHome(env: Env, userId: string): Promise<void> {
  const data = await loadHomeData(env.DB, userId);
  const view = buildHomeView(data, userId, Date.now());
  await slackCall(env, "views.publish", { user_id: userId, view });
}
