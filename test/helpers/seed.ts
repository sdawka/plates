// Direct D1 seeding for scenarios that need many asks or specific states without playing the full flow.
import { insertAskStmt, insertRequest, saveAskStmt } from "../../src/domain/repo";
import type { AskRow, DraftAsk, Env, RequestRow } from "../../src/types";
import { CHANNEL, USERS } from "./env";

/** Anything with an Env: a Harness, or `{ env }` in domain tests. */
type HasEnv = { env: Env };

export function mkRequest(over: Partial<RequestRow> = {}): RequestRow {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    channel_id: CHANNEL,
    thread_ts: "1792400000.000100",
    message_ts: null,
    status: "confirmed",
    tagged_by_id: USERS.tara,
    tag_message_ts: null,
    requester_id: USERS.dana,
    owner_id: USERS.bob,
    attribution_confidence: 0.95,
    attribution_reason: null,
    clarify_question: null,
    draft_json: "[]",
    confirmed_by: USERS.dana,
    confirmed_via: "reaction",
    nudged_at: null,
    created_at: now,
    updated_at: now,
    ...over,
  };
}

export function mkAsk(requestId: string, i: number, over: Partial<AskRow> = {}): AskRow {
  const now = Date.now() + i;
  return {
    id: crypto.randomUUID(),
    request_id: requestId,
    requester_id: USERS.dana,
    owner_id: USERS.bob,
    holder_id: USERS.bob,
    title: `Ask number ${i}`,
    detail: null,
    type: "deliverable",
    state: "proposed",
    snoozed_from: null,
    size: "hours",
    size_source: "llm",
    urgency: "normal",
    urgency_source: "llm",
    estimate_reason: null,
    inferred_due_at: null,
    deadline_at: null,
    deadline_change_count: 0,
    snoozed_until: null,
    snooze_count: 0,
    round_count: 0,
    source_ts: null,
    source_permalink: null,
    next_step: null,
    done_link: null,
    last_note: null,
    created_at: now,
    accepted_at: null,
    closed_at: null,
    updated_at: now,
    reminder_stage: 0,
    last_reminded_at: null,
    last_bumped_at: null,
    tracker_ref: null,
    tracker_url: null,
    ...over,
  };
}

export const mkDraft = (i: number, over: Partial<DraftAsk> = {}): DraftAsk => ({
  title: `Draft ask ${i}`,
  detail: null,
  type: "deliverable",
  size: "hours",
  urgency: "normal",
  estimate_reason: "seed",
  inferred_due_at: null,
  owner_already_committed: false,
  source_ts: "1792400000.000100",
  source_permalink: null,
  ...over,
});

export async function seedRequest(h: HasEnv, req: Partial<RequestRow> = {}, asks: Partial<AskRow>[] = []): Promise<{ req: RequestRow; asks: AskRow[] }> {
  const row = mkRequest(req);
  await insertRequest(h.env.DB, row);
  const rows = asks.map((o, i) => mkAsk(row.id, i, o));
  if (rows.length) await h.env.DB.batch(rows.map((a) => insertAskStmt(h.env.DB, a)));
  return { req: row, asks: rows };
}

export const saveAsk = (h: HasEnv, a: AskRow) => h.env.DB.batch([saveAskStmt(h.env.DB, a, a.updated_at)]);
