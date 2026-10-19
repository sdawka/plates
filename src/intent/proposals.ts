// D1 access for the proposals table (inferred actions waiting for a yes/no).

import type { ProposalRow, ProposalStatus } from "../types";

export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

export const isExpired = (p: Pick<ProposalRow, "created_at">, now: number) => now - p.created_at > PROPOSAL_TTL_MS;

const COLUMNS = [
  "id", "source", "request_id", "ask_id", "actor_id", "action_json", "channel_id", "thread_ts",
  "source_ts", "message_ts", "status", "created_at", "updated_at",
] as const satisfies readonly (keyof ProposalRow)[];

export async function insertProposal(db: D1Database, row: ProposalRow): Promise<void> {
  await db
    .prepare(`INSERT INTO proposals (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`)
    .bind(...COLUMNS.map((c) => row[c]))
    .run();
}

export async function getProposal(db: D1Database, id: string): Promise<ProposalRow | null> {
  return db.prepare("SELECT * FROM proposals WHERE id = ?").bind(id).first<ProposalRow>();
}

export async function setProposalMessage(db: D1Database, id: string, messageTs: string): Promise<void> {
  await db.prepare("UPDATE proposals SET message_ts = ?, updated_at = ? WHERE id = ?").bind(messageTs, Date.now(), id).run();
}

export async function setProposalAsk(db: D1Database, id: string, askId: string, requestId: string): Promise<void> {
  await db
    .prepare("UPDATE proposals SET ask_id = ?, request_id = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
    .bind(askId, requestId, Date.now(), id)
    .run();
}

/** Atomically move a proposal out of `from`. False when someone else got there first. */
export async function moveProposal(db: D1Database, id: string, from: ProposalStatus, to: ProposalStatus): Promise<boolean> {
  const r = await db
    .prepare("UPDATE proposals SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
    .bind(to, Date.now(), id, from)
    .run();
  return r.meta.changes === 1;
}

/** A pending "looks done?" suggestion for this ask, so one upload doesn't ask twice. */
export async function hasPendingDetector(db: D1Database, askId: string, since: number): Promise<boolean> {
  const r = await db
    .prepare("SELECT 1 AS x FROM proposals WHERE ask_id = ? AND source = 'detector' AND status = 'pending' AND created_at > ? LIMIT 1")
    .bind(askId, since)
    .first();
  return r !== null;
}

/** Queue redelivery guard: has this message already produced an action or a proposal? */
export async function sourceHandled(db: D1Database, channelId: string, sourceTs: string): Promise<boolean> {
  const p = await db.prepare("SELECT 1 AS x FROM proposals WHERE channel_id = ? AND source_ts = ? LIMIT 1").bind(channelId, sourceTs).first();
  if (p) return true;
  const e = await db
    .prepare(
      `SELECT 1 AS x FROM ask_events WHERE source_ts = ? AND via = 'thread_reply'
         AND request_id IN (SELECT id FROM requests WHERE channel_id = ?) LIMIT 1`,
    )
    .bind(sourceTs, channelId)
    .first();
  return e !== null;
}
