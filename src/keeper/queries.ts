// Keeper-owned D1 queries for the reminder ladder.
import type { AskRow } from "../types";

/** Asks on this user's plate that the ladder may remind about. */
export async function listReminderCandidates(db: D1Database, holderId: string): Promise<AskRow[]> {
  const r = await db
    .prepare(
      `SELECT * FROM asks WHERE holder_id = ? AND state IN ('proposed', 'accepted', 'in_progress', 'rejected', 'clarify')
         ORDER BY created_at`,
    )
    .bind(holderId)
    .all<AskRow>();
  return r.results;
}

/**
 * Advance an ask's ladder. Leaves updated_at alone (the optimistic-concurrency token for user actions) and
 * only succeeds if nothing moved the ask since it was read. Returns whether this call claimed it.
 */
export async function claimReminder(db: D1Database, ask: AskRow, now: number): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE asks SET reminder_stage = ?, last_reminded_at = ?
         WHERE id = ? AND reminder_stage = ? AND updated_at = ? AND holder_id = ?`,
    )
    .bind(ask.reminder_stage + 1, now, ask.id, ask.reminder_stage, ask.updated_at, ask.holder_id)
    .run();
  return (r.meta.changes ?? 0) > 0;
}
