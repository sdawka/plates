// STUB — Phase 3 tracker sync (Jira / Linear). No-op until implemented or when env.TRACKER is unset.
import type { Env } from "../types";

/** Mirror a deliverable ask's current state to the configured tracker. Idempotent. */
export async function syncTracker(env: Env, askId: string): Promise<void> {
  if (!env.TRACKER) return;
}
