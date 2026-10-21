// The only entry points that change asks or confirm requests. Buttons, Home, thread replies,
// reactions and PlateKeeper all go through here. Returns effects for src/effects.ts to execute.

import {
  OWNER_PLATE_STATES,
  TransitionError,
  type Actor,
  type AskAction,
  type AskEventRow,
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
  getEvent,
  getRequest,
  insertAskIfChangedStmt,
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

export interface ApplyResult {
  effects: Effect[];
  eventId: string;
  before: AskRow;
  after: AskRow;
}

/** Shorthand when the caller only needs the effects. */
export async function applyAction(
  env: Env,
  askId: string,
  action: AskAction,
  actor: Actor,
  via: Via,
  sourceTs: string | null = null,
): Promise<Effect[]> {
  return (await applyActionDetailed(env, askId, action, actor, via, sourceTs)).effects;
}

export async function applyActionDetailed(
  env: Env,
  askId: string,
  action: AskAction,
  actor: Actor,
  via: Via,
  sourceTs: string | null = null,
): Promise<ApplyResult> {
  const ask = await getAsk(env.DB, askId);
  if (!ask) throw new TransitionError(`ask ${askId} not found`, "That ask no longer exists.");

  const now = Math.max(Date.now(), ask.updated_at + 1);
  const { next, eventKind, note, dm } = transition(ask, action, actor, now);
  // Any move, new holder or new deadline restarts the reminder ladder.
  if (next.state !== ask.state || next.holder_id !== ask.holder_id || next.deadline_at !== ask.deadline_at) {
    next.reminder_stage = 0;
    next.last_reminded_at = null;
  }

  const eventId = newId();
  await saveWithEvent(env, ask, next, {
    id: eventId,
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
    prev_json: JSON.stringify(ask),
  });

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
  if (next.type === "deliverable") effects.push({ kind: "tracker_sync", askId: ask.id });
  return { effects, eventId, before: ask, after: next };
}

async function saveWithEvent(env: Env, prev: AskRow, next: AskRow, event: AskEventRow): Promise<void> {
  const [save] = await env.DB.batch([
    saveAskStmt(env.DB, next, prev.updated_at),
    insertEventIfChangedStmt(env.DB, event),
  ]);
  if (!save || save.meta.changes !== 1) {
    // Someone else changed it first; the event insert was skipped too.
    throw new TransitionError(`ask ${prev.id} changed concurrently`, "Someone just changed this ask. Please try again.");
  }
}

export const UNDO_WINDOW_MS = 15 * 60 * 1000;

/**
 * Undo an action: only by the person who did it, within UNDO_WINDOW_MS, and only if nothing
 * has changed the ask since. Restores the snapshot and tells whoever was notified of the move.
 */
export async function undoEvent(env: Env, eventId: string, actor: string, via: Via): Promise<Effect[]> {
  const event = await getEvent(env.DB, eventId);
  if (!event?.ask_id || !event.prev_json) throw new TransitionError(`event ${eventId} not undoable`, "That can't be undone.");
  if (event.actor_id !== actor) throw new TransitionError("undo by other user", "Only the person who did this can undo it.");
  if (event.kind === "undo") throw new TransitionError("undo of undo", "That can't be undone.");
  const now = Date.now();
  if (now - event.at > UNDO_WINDOW_MS) throw new TransitionError("undo window passed", "It's too late to undo that. Use the buttons instead.");

  const current = await getAsk(env.DB, event.ask_id);
  if (!current || current.updated_at !== event.at) {
    throw new TransitionError("ask changed since", "This ask has changed since, so it can't be undone.");
  }
  // Restore what the action changed; keep bookkeeping that happened independently since.
  const restored: AskRow = {
    ...(JSON.parse(event.prev_json) as AskRow),
    last_bumped_at: current.last_bumped_at,
    tracker_ref: current.tracker_ref,
    tracker_url: current.tracker_url,
    reminder_stage: 0,
    last_reminded_at: null,
    updated_at: Math.max(now, current.updated_at + 1),
  };
  await saveWithEvent(env, current, restored, {
    id: newId(),
    ask_id: current.id,
    request_id: current.request_id,
    actor_id: actor,
    kind: "undo",
    from_state: current.state,
    to_state: restored.state,
    note: event.kind,
    via,
    source_ts: null,
    at: restored.updated_at,
    prev_json: null,
  });

  const effects: Effect[] = [{ kind: "render_request", requestId: current.request_id }];
  // Whoever received the ask (or a notification about it) hears that it was undone.
  const notified = current.holder_id !== restored.holder_id ? current.holder_id : null;
  if (notified && notified !== actor) {
    effects.push({ kind: "dm", userId: notified, template: "action_undone", requestId: current.request_id, askId: current.id, note: event.kind });
  }
  effects.push(...fanOut([current.requester_id, current.owner_id, restored.owner_id]));
  if (current.type === "deliverable") effects.push({ kind: "tracker_sync", askId: current.id });
  return effects;
}

export const BUMP_INTERVAL_MS = 20 * 60 * 60 * 1000; // "once per day", tolerant of timezones

/** Requester nudges the owner about an ask on the owner's plate. */
export async function bumpAsk(env: Env, askId: string, actor: string, via: Via): Promise<Effect[]> {
  const ask = await getAsk(env.DB, askId);
  if (!ask) throw new TransitionError(`ask ${askId} not found`, "That ask no longer exists.");
  if (actor !== ask.requester_id) throw new TransitionError("bump by non-requester", "Only the person who asked can bump it.");
  if (!OWNER_PLATE_STATES.includes(ask.state)) throw new TransitionError("bump off owner plate", "This ask isn't waiting on anyone right now.");
  const now = Date.now();
  if (ask.last_bumped_at && now - ask.last_bumped_at < BUMP_INTERVAL_MS) {
    throw new TransitionError("bumped recently", "You've already bumped this today.");
  }
  const res = await env.DB.batch([
    env.DB.prepare("UPDATE asks SET last_bumped_at = ? WHERE id = ? AND (last_bumped_at IS NULL OR last_bumped_at <= ?)")
      .bind(now, ask.id, now - BUMP_INTERVAL_MS),
    insertEventIfChangedStmt(env.DB, {
      id: newId(), ask_id: ask.id, request_id: ask.request_id, actor_id: actor, kind: "bump",
      from_state: ask.state, to_state: ask.state, note: null, via, source_ts: null, at: now, prev_json: null,
    }),
  ]);
  if (res[0]?.meta.changes !== 1) throw new TransitionError("bumped concurrently", "You've already bumped this today.");
  return [
    { kind: "dm", userId: ask.owner_id, template: "bump", requestId: ask.request_id, askId: ask.id },
    { kind: "refresh_home", userId: ask.requester_id },
  ];
}

/** Requester or owner confirms a pending request: create its asks and notify the owner. */
export async function confirmRequest(env: Env, requestId: string, userId: string, via: Via): Promise<Effect[]> {
  const req = await getRequest(env.DB, requestId);
  if (!req) throw new TransitionError(`request ${requestId} not found`, "That request no longer exists.");
  if (req.status === "confirmed") throw new TransitionError("already confirmed", "This is already confirmed.");
  if (req.status === "dismissed") throw new TransitionError("dismissed", "This request was dismissed.");
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
    reminder_stage: 0,
    last_reminded_at: null,
    last_bumped_at: null,
    tracker_ref: null,
    tracker_url: null,
  }));

  // One transaction: claim the request, then each insert runs only if the statement before it
  // changed a row. A second, concurrent confirm loses the claim and inserts nothing.
  const [claim] = await env.DB.batch([
    env.DB.prepare(
      "UPDATE requests SET status = 'confirmed', confirmed_by = ?, confirmed_via = ?, updated_at = ? WHERE id = ? AND status = 'pending_confirmation'",
    ).bind(userId, via, now, req.id),
    ...asks.map((a) => insertAskIfChangedStmt(env.DB, a)),
    insertEventIfChangedStmt(env.DB, {
      id: newId(), ask_id: null, request_id: req.id, actor_id: userId, kind: "confirm",
      from_state: null, to_state: null, note: null, via, source_ts: null, at: now, prev_json: null,
    }),
  ]);
  if (claim?.meta.changes !== 1) throw new TransitionError("already confirmed", "This is already confirmed.");

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

/** Anyone involved drops a request nobody confirmed (pending or discarded). Final: it leaves every Home. */
export async function dismissRequest(env: Env, requestId: string, userId: string, via: Via): Promise<Effect[]> {
  const req = await getRequest(env.DB, requestId);
  if (!req) throw new TransitionError(`request ${requestId} not found`, "That request no longer exists.");
  if (req.status === "confirmed") throw new TransitionError("already confirmed", "This is already confirmed. Withdraw or reject its asks instead.");
  if (req.status === "dismissed") throw new TransitionError("already dismissed", "This was already dismissed.");
  if (userId !== req.tagged_by_id && userId !== req.requester_id && userId !== req.owner_id) {
    throw new TransitionError(`${userId} cannot dismiss`, "Only the people involved can dismiss this.");
  }

  const now = Date.now();
  const [claim] = await env.DB.batch([
    env.DB.prepare(
      "UPDATE requests SET status = 'dismissed', updated_at = ? WHERE id = ? AND status IN ('pending_confirmation', 'discarded')",
    ).bind(now, req.id),
    insertEventIfChangedStmt(env.DB, {
      id: newId(), ask_id: null, request_id: req.id, actor_id: userId, kind: "dismiss",
      from_state: null, to_state: null, note: null, via, source_ts: null, at: now, prev_json: null,
    }),
  ]);
  if (claim?.meta.changes !== 1) throw new TransitionError("already handled", "This was already confirmed or dismissed.");

  return [{ kind: "render_request", requestId: req.id }, ...fanOut([req.requester_id, req.owner_id, req.tagged_by_id])];
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
