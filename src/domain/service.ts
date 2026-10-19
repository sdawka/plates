// The only entry points that change asks or confirm requests. Buttons, Home, thread replies,
// reactions and PlateKeeper all go through here. Returns effects for src/effects.ts to execute.

import {
  TransitionError,
  type Actor,
  type AskAction,
  type AskRow,
  type DraftAsk,
  type Effect,
  type Env,
  type RequestRow,
  type Via,
} from "../types";
import { transition } from "./transitions";
import {
  getAsk,
  getRequest,
  insertAskStmt,
  insertEventIfChangedStmt,
  insertEventStmt,
  newId,
  saveAskStmt,
  updateRequest,
} from "./repo";

function fanOut(userIds: (string | null | undefined)[]): Effect[] {
  const ids = [...new Set(userIds.filter((u): u is string => !!u && u !== "system"))];
  return ids.flatMap((userId): Effect[] => [
    { kind: "refresh_home", userId },
    { kind: "reschedule", userId },
  ]);
}

export async function applyAction(
  env: Env,
  askId: string,
  action: AskAction,
  actor: Actor,
  via: Via,
  sourceTs: string | null = null,
): Promise<Effect[]> {
  const ask = await getAsk(env.DB, askId);
  if (!ask) throw new TransitionError(`ask ${askId} not found`, "That ask no longer exists.");

  const now = Math.max(Date.now(), ask.updated_at + 1);
  const { next, eventKind, note, dm } = transition(ask, action, actor, now);

  const [save] = await env.DB.batch([
    saveAskStmt(env.DB, next, ask.updated_at),
    insertEventIfChangedStmt(env.DB, {
      id: newId(),
      ask_id: ask.id,
      request_id: ask.request_id,
      actor_id: actor,
      kind: eventKind,
      from_state: ask.state,
      to_state: next.state,
      note,
      via,
      source_ts: sourceTs,
      at: now,
    }),
  ]);
  if (!save || save.meta.changes !== 1) {
    // Someone else changed it first; the event insert was skipped too.
    throw new TransitionError(`ask ${askId} changed concurrently`, "Someone just changed this ask. Please try again.");
  }

  const effects: Effect[] = [{ kind: "render_request", requestId: ask.request_id }];
  if (dm) {
    effects.push({
      kind: "dm",
      userId: dm.userId,
      template: dm.template,
      requestId: ask.request_id,
      askId: ask.id,
      note: note ?? undefined,
      ...(dm.template === "deadline_changed" && { deadline: { from: ask.deadline_at, to: next.deadline_at } }),
    });
  }
  effects.push(...fanOut([ask.requester_id, ask.owner_id, next.owner_id]));
  return effects;
}

/** Requester or owner confirms a pending request: create its asks and notify the owner. */
export async function confirmRequest(env: Env, requestId: string, userId: string, via: Via): Promise<Effect[]> {
  const req = await getRequest(env.DB, requestId);
  if (!req) throw new TransitionError(`request ${requestId} not found`, "That request no longer exists.");
  if (req.status === "confirmed") throw new TransitionError("already confirmed", "This is already confirmed.");
  assertCanConfirm(req, userId);

  const now = Date.now();
  const drafts = JSON.parse(req.draft_json) as DraftAsk[];
  const asks: AskRow[] = drafts.map((d, i) => ({
    id: newId(),
    request_id: req.id,
    requester_id: req.requester_id!,
    owner_id: req.owner_id!,
    holder_id: req.owner_id!,
    title: d.title,
    detail: d.detail,
    type: d.type,
    state: "proposed",
    snoozed_from: null,
    size: d.size,
    size_source: "llm",
    urgency: d.urgency,
    urgency_source: "llm",
    estimate_reason: d.estimate_reason,
    inferred_due_at: d.inferred_due_at,
    deadline_at: null,
    deadline_change_count: 0,
    snoozed_until: null,
    snooze_count: 0,
    round_count: 0,
    source_ts: d.source_ts,
    source_permalink: d.source_permalink,
    next_step: null,
    done_link: null,
    last_note: null,
    created_at: now + i, // keeps extraction order stable
    accepted_at: null,
    closed_at: null,
    updated_at: now + i,
  }));

  // Claim the confirmation first so two simultaneous confirms can't both create the asks.
  const claim = await env.DB.prepare(
    "UPDATE requests SET status = 'confirmed', confirmed_by = ?, confirmed_via = ?, updated_at = ? WHERE id = ? AND status = 'pending_confirmation'",
  )
    .bind(userId, via, now, req.id)
    .run();
  if (claim.meta.changes !== 1) throw new TransitionError("already confirmed", "This is already confirmed.");

  await env.DB.batch([
    ...asks.map((a) => insertAskStmt(env.DB, a)),
    insertEventStmt(env.DB, {
      id: newId(), ask_id: null, request_id: req.id, actor_id: userId, kind: "confirm",
      from_state: null, to_state: null, note: null, via, source_ts: null, at: now,
    }),
  ]);

  return [
    { kind: "render_request", requestId: req.id },
    { kind: "dm", userId: req.owner_id, template: "request_proposed", requestId: req.id },
    ...fanOut([req.requester_id, req.owner_id, req.tagged_by_id]),
  ];
}

/** Unconfirmed after the nudge: mark discarded (still visible as "unconfirmed" on Home). */
export async function discardRequest(env: Env, requestId: string): Promise<Effect[]> {
  const req = await getRequest(env.DB, requestId);
  if (!req || req.status !== "pending_confirmation") return [];
  await updateRequest(env.DB, req.id, { status: "discarded" });
  return [{ kind: "render_request", requestId: req.id }, ...fanOut([req.requester_id, req.owner_id, req.tagged_by_id])];
}

/** Undo a discard (requester or owner confirms from Home later): back to pending, then confirm. */
export async function confirmDiscarded(env: Env, requestId: string, userId: string, via: Via): Promise<Effect[]> {
  const req = await getRequest(env.DB, requestId);
  if (req?.status === "discarded") {
    assertCanConfirm(req, userId);
    await updateRequest(env.DB, req.id, { status: "pending_confirmation" });
  }
  return confirmRequest(env, requestId, userId, via);
}

function assertCanConfirm(
  req: RequestRow,
  userId: string,
): asserts req is RequestRow & { requester_id: string; owner_id: string } {
  if (!req.requester_id || !req.owner_id) {
    throw new TransitionError("attribution unresolved", "I still need to know who is asking whom. Reply in the thread to tell me.");
  }
  if (userId !== req.requester_id && userId !== req.owner_id) {
    throw new TransitionError(`${userId} cannot confirm`, `Needs a ✅ from <@${req.requester_id}> or <@${req.owner_id}>.`);
  }
}
