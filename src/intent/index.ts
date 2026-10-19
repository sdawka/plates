// STUB — Phase 2 thread-reply intent handling.
import type { Effect, Env, ExtractJob } from "../types";

export async function handleIntentJob(env: Env, job: Extract<ExtractJob, { kind: "intent" }>): Promise<Effect[]> {
  return [];
}
