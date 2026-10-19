// D1 data access. Every module reads and writes through these functions.

import type { AskEventRow, AskRow, RequestRow, UserPrefsRow } from "../types";

export const newId = () => crypto.randomUUID();

const ASK_COLUMNS = [
  "id", "request_id", "requester_id", "owner_id", "holder_id", "title", "detail", "type", "state",
  "snoozed_from", "size", "size_source", "urgency", "urgency_source", "estimate_reason",
  "inferred_due_at", "deadline_at", "deadline_change_count", "snoozed_until", "snooze_count",
  "round_count", "source_ts", "source_permalink", "next_step", "done_link", "last_note",
  "created_at", "accepted_at", "closed_at", "updated_at",
  "reminder_stage", "last_reminded_at", "last_bumped_at", "tracker_ref", "tracker_url",
] as const satisfies readonly (keyof AskRow)[];

const REQUEST_COLUMNS = [
  "id", "channel_id", "thread_ts", "message_ts", "status", "tagged_by_id", "tag_message_ts", "requester_id", "owner_id",
  "attribution_confidence", "attribution_reason", "clarify_question", "draft_json", "confirmed_by",
  "confirmed_via", "nudged_at", "created_at", "updated_at",
] as const satisfies readonly (keyof RequestRow)[];

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

// ---------- Requests ----------

export async function getRequest(db: D1Database, id: string): Promise<RequestRow | null> {
  return db.prepare("SELECT * FROM requests WHERE id = ?").bind(id).first<RequestRow>();
}

/** The request whose confirmation / live message is `messageTs` (used for reactions). */
export async function getRequestByMessage(db: D1Database, channelId: string, messageTs: string): Promise<RequestRow | null> {
  return db.prepare("SELECT * FROM requests WHERE channel_id = ? AND message_ts = ?").bind(channelId, messageTs).first<RequestRow>();
}

export async function getRequestsInThread(db: D1Database, channelId: string, threadTs: string): Promise<RequestRow[]> {
  const r = await db
    .prepare("SELECT * FROM requests WHERE channel_id = ? AND thread_ts = ? ORDER BY created_at")
    .bind(channelId, threadTs)
    .all<RequestRow>();
  return r.results;
}

export function insertRequestStmt(db: D1Database, row: RequestRow): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO requests (${REQUEST_COLUMNS.join(", ")}) VALUES (${placeholders(REQUEST_COLUMNS.length)})`)
    .bind(...REQUEST_COLUMNS.map((c) => row[c]));
}

export async function insertRequest(db: D1Database, row: RequestRow): Promise<void> {
  await insertRequestStmt(db, row).run();
}

export async function updateRequest(db: D1Database, id: string, patch: Partial<Omit<RequestRow, "id">>): Promise<void> {
  const entries = Object.entries({ ...patch, updated_at: patch.updated_at ?? Date.now() });
  await db
    .prepare(`UPDATE requests SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .bind(...entries.map(([, v]) => v ?? null), id)
    .run();
}

/** Like updateRequest, but only while the request is still pending_confirmation. Returns false if it lost the race. */
export async function updateRequestIfPending(db: D1Database, id: string, patch: Partial<Omit<RequestRow, "id">>): Promise<boolean> {
  const entries = Object.entries({ ...patch, updated_at: patch.updated_at ?? Date.now() });
  const r = await db
    .prepare(`UPDATE requests SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ? AND status = 'pending_confirmation'`)
    .bind(...entries.map(([, v]) => v ?? null), id)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/** Pending confirmations where the user is the requester, the owner or the tagger. */
export async function listUnconfirmedFor(db: D1Database, userId: string): Promise<RequestRow[]> {
  const r = await db
    .prepare(
      `SELECT * FROM requests WHERE status IN ('pending_confirmation', 'discarded')
         AND (requester_id = ?1 OR owner_id = ?1 OR tagged_by_id = ?1)
       ORDER BY created_at DESC LIMIT 50`,
    )
    .bind(userId)
    .all<RequestRow>();
  return r.results;
}

/** Pending confirmations the user can confirm (requester or owner); used by PlateKeeper for nudges. */
export async function listPendingToConfirm(db: D1Database, userId: string): Promise<RequestRow[]> {
  const r = await db
    .prepare(
      `SELECT * FROM requests WHERE status = 'pending_confirmation'
         AND (requester_id = ?1 OR owner_id = ?1) ORDER BY created_at`,
    )
    .bind(userId)
    .all<RequestRow>();
  return r.results;
}

// ---------- Asks ----------

export async function getAsk(db: D1Database, id: string): Promise<AskRow | null> {
  return db.prepare("SELECT * FROM asks WHERE id = ?").bind(id).first<AskRow>();
}

export async function getAsksByRequest(db: D1Database, requestId: string): Promise<AskRow[]> {
  const r = await db.prepare("SELECT * FROM asks WHERE request_id = ? ORDER BY created_at, rowid").bind(requestId).all<AskRow>();
  return r.results;
}

export function insertAskStmt(db: D1Database, row: AskRow): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO asks (${ASK_COLUMNS.join(", ")}) VALUES (${placeholders(ASK_COLUMNS.length)})`)
    .bind(...ASK_COLUMNS.map((c) => row[c]));
}

/** Inserts the ask only if the previous statement in the same batch changed exactly one row. */
export function insertAskIfChangedStmt(db: D1Database, row: AskRow): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO asks (${ASK_COLUMNS.join(", ")}) SELECT ${placeholders(ASK_COLUMNS.length)} WHERE changes() = 1`)
    .bind(...ASK_COLUMNS.map((c) => row[c]));
}

/** Optimistic write: only succeeds if the row hasn't changed since `prevUpdatedAt`. */
export function saveAskStmt(db: D1Database, row: AskRow, prevUpdatedAt: number): D1PreparedStatement {
  const cols = ASK_COLUMNS.filter((c) => c !== "id");
  return db
    .prepare(`UPDATE asks SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ? AND updated_at = ?`)
    .bind(...cols.map((c) => row[c]), row.id, prevUpdatedAt);
}

/** Everything on a user's plate (they are the holder), oldest first. */
export async function listPlate(db: D1Database, userId: string): Promise<AskRow[]> {
  const r = await db
    .prepare(
      `SELECT * FROM asks WHERE holder_id = ? AND state NOT IN ('closed', 'withdrawn') ORDER BY created_at`,
    )
    .bind(userId)
    .all<AskRow>();
  return r.results;
}

/** Asks the user made that are currently on someone else's plate. */
export async function listWaitingOn(db: D1Database, requesterId: string): Promise<AskRow[]> {
  const r = await db
    .prepare(
      `SELECT * FROM asks WHERE requester_id = ?1 AND holder_id != ?1
         AND state NOT IN ('closed', 'withdrawn') ORDER BY created_at`,
    )
    .bind(requesterId)
    .all<AskRow>();
  return r.results;
}

export async function listDueSnoozes(db: D1Database, ownerId: string, now: number): Promise<AskRow[]> {
  const r = await db
    .prepare("SELECT * FROM asks WHERE owner_id = ? AND state = 'snoozed' AND snoozed_until <= ?")
    .bind(ownerId, now)
    .all<AskRow>();
  return r.results;
}

export async function nextSnoozeWake(db: D1Database, ownerId: string): Promise<number | null> {
  const r = await db
    .prepare("SELECT MIN(snoozed_until) AS t FROM asks WHERE owner_id = ? AND state = 'snoozed'")
    .bind(ownerId)
    .first<{ t: number | null }>();
  return r?.t ?? null;
}

/** Targeted write of the digest timestamp; never touches settings columns saved meanwhile. */
export async function recordDigestSent(db: D1Database, userId: string, now: number): Promise<void> {
  const d = defaultPrefs(userId);
  await db
    .prepare(
      `INSERT INTO user_prefs (user_id, tz, work_start_hour, work_end_hour, digest_time, max_reminders_per_day, last_digest_at,
         reminders_day, reminders_sent, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)
       ON CONFLICT(user_id) DO UPDATE SET last_digest_at = excluded.last_digest_at`,
    )
    .bind(userId, d.tz, d.work_start_hour, d.work_end_hour, d.digest_time, d.max_reminders_per_day, now, Date.now())
    .run();
}

/** Targeted, atomic bump of the daily reminder counter (resets when the local day changed). */
export async function recordRemindersSent(db: D1Database, userId: string, day: string, count: number): Promise<void> {
  const d = defaultPrefs(userId);
  await db
    .prepare(
      `INSERT INTO user_prefs (user_id, tz, work_start_hour, work_end_hour, digest_time, max_reminders_per_day, last_digest_at,
         reminders_day, reminders_sent, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         reminders_sent = CASE WHEN user_prefs.reminders_day = excluded.reminders_day
                               THEN user_prefs.reminders_sent + excluded.reminders_sent ELSE excluded.reminders_sent END,
         reminders_day = excluded.reminders_day`,
    )
    .bind(userId, d.tz, d.work_start_hour, d.work_end_hour, d.digest_time, d.max_reminders_per_day, day, count, Date.now())
    .run();
}

// ---------- Events ----------

const EVENT_INSERT = `INSERT INTO ask_events (id, ask_id, request_id, actor_id, kind, from_state, to_state, note, via, source_ts, at, prev_json)`;
const eventValues = (e: AskEventRow) =>
  [e.id, e.ask_id, e.request_id, e.actor_id, e.kind, e.from_state, e.to_state, e.note, e.via, e.source_ts, e.at, e.prev_json] as const;

export function insertEventStmt(db: D1Database, e: AskEventRow): D1PreparedStatement {
  return db.prepare(`${EVENT_INSERT} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(...eventValues(e));
}

/** Inserts the event only if the previous statement in the same batch changed exactly one row. */
export function insertEventIfChangedStmt(db: D1Database, e: AskEventRow): D1PreparedStatement {
  return db
    .prepare(`${EVENT_INSERT} SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`)
    .bind(...eventValues(e));
}

export async function getEvent(db: D1Database, id: string): Promise<AskEventRow | null> {
  return db.prepare("SELECT * FROM ask_events WHERE id = ?").bind(id).first<AskEventRow>();
}

export async function listEvents(db: D1Database, askId: string): Promise<AskEventRow[]> {
  const r = await db.prepare("SELECT * FROM ask_events WHERE ask_id = ? ORDER BY at").bind(askId).all<AskEventRow>();
  return r.results;
}

// ---------- User prefs ----------

export function defaultPrefs(userId: string): UserPrefsRow {
  return {
    user_id: userId,
    tz: "UTC",
    work_start_hour: 9,
    work_end_hour: 17,
    digest_time: "09:00",
    max_reminders_per_day: 5,
    last_digest_at: null,
    updated_at: 0,
    reminders_day: null,
    reminders_sent: 0,
  };
}

export async function getPrefs(db: D1Database, userId: string): Promise<UserPrefsRow> {
  return (await db.prepare("SELECT * FROM user_prefs WHERE user_id = ?").bind(userId).first<UserPrefsRow>()) ?? defaultPrefs(userId);
}

export async function upsertPrefs(db: D1Database, p: UserPrefsRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO user_prefs (user_id, tz, work_start_hour, work_end_hour, digest_time, max_reminders_per_day, last_digest_at,
         reminders_day, reminders_sent, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET tz = excluded.tz, work_start_hour = excluded.work_start_hour,
         work_end_hour = excluded.work_end_hour, digest_time = excluded.digest_time,
         max_reminders_per_day = excluded.max_reminders_per_day, last_digest_at = excluded.last_digest_at,
         reminders_day = excluded.reminders_day, reminders_sent = excluded.reminders_sent,
         updated_at = excluded.updated_at`,
    )
    .bind(p.user_id, p.tz, p.work_start_hour, p.work_end_hour, p.digest_time, p.max_reminders_per_day, p.last_digest_at,
      p.reminders_day, p.reminders_sent, Date.now())
    .run();
}
