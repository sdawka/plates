// Tracker sync: mirrors a deliverable ask's state to Jira or Linear. Idempotent: tracker_sync remembers
// what the tracker last saw, so a redelivered tracker_sync effect only does the outstanding work.
import { slackCall } from "../slack/api";
import type { AskRow, Env } from "../types";
import { buildDescription, isoDate, planSync, type People, type SyncState } from "./describe";
import { jiraFromEnv } from "./jira";
import { linearFromEnv } from "./linear";
import type { Tracker } from "./types";

export function trackerFromEnv(env: Env): Tracker | null {
  if (env.TRACKER === "jira") return jiraFromEnv(env);
  if (env.TRACKER === "linear") return linearFromEnv(env);
  return null;
}

interface SlackUser {
  name: string;
  email: string | null;
  tz: string | null;
}

/** Display name and email (needs users:read.email) for a Slack user; degrades to the raw id. */
async function slackUser(env: Env, id: string): Promise<SlackUser> {
  try {
    const r = await slackCall<{
      user: { name?: string; real_name?: string; tz?: string; profile?: { email?: string; display_name?: string; real_name?: string } };
    }>(env, "users.info", { user: id });
    const u = r.user;
    return {
      name: u.profile?.real_name || u.real_name || u.profile?.display_name || u.name || id,
      email: u.profile?.email ?? null,
      tz: u.tz ?? null,
    };
  } catch (e) {
    console.warn(`tracker: users.info ${id} failed`, e instanceof Error ? e.message : e);
    return { name: id, email: null, tz: null };
  }
}

async function loadSync(db: D1Database, askId: string): Promise<SyncState | null> {
  return db.prepare("SELECT state, deadline_at, owner_id FROM tracker_sync WHERE ask_id = ?").bind(askId).first<SyncState>();
}

async function saveSync(db: D1Database, askId: string, s: SyncState): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tracker_sync (ask_id, state, deadline_at, owner_id, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(ask_id) DO UPDATE SET state = excluded.state, deadline_at = excluded.deadline_at,
         owner_id = excluded.owner_id, updated_at = excluded.updated_at, creating_at = NULL`,
    )
    .bind(askId, s.state, s.deadline_at, s.owner_id, Date.now())
    .run();
}

const CLAIM_LEASE_MS = 2 * 60_000;

/** Atomically take the right to create the issue; a claim older than the lease is considered crashed. */
async function claimCreate(db: D1Database, askId: string): Promise<boolean> {
  const now = Date.now();
  const r = await db
    .prepare(
      `INSERT INTO tracker_sync (ask_id, updated_at, creating_at) VALUES (?, ?, ?)
       ON CONFLICT(ask_id) DO UPDATE SET creating_at = excluded.creating_at
         WHERE tracker_sync.creating_at IS NULL OR tracker_sync.creating_at < ?`,
    )
    .bind(askId, now, now, now - CLAIM_LEASE_MS)
    .run();
  return r.meta.changes > 0;
}

async function releaseClaim(db: D1Database, askId: string): Promise<void> {
  await db.prepare("UPDATE tracker_sync SET creating_at = NULL WHERE ask_id = ?").bind(askId).run();
}

/** Mirror a deliverable ask's current state to the configured tracker. Idempotent. */
export async function syncTracker(env: Env, askId: string): Promise<void> {
  const tracker = trackerFromEnv(env);
  if (!tracker) return;
  try {
    await sync(env, tracker, askId);
  } catch (e) {
    console.error(`tracker sync failed for ask ${askId}`, e instanceof Error ? e.message : e);
  }
}

async function sync(env: Env, tracker: Tracker, askId: string): Promise<void> {
  const ask = await env.DB.prepare("SELECT * FROM asks WHERE id = ?").bind(askId).first<AskRow>();
  if (!ask || ask.type !== "deliverable") return;

  let ref = ask.tracker_ref;
  let prev = await loadSync(env.DB, askId);

  const [requester, owner] = await Promise.all([slackUser(env, ask.requester_id), slackUser(env, ask.owner_id)]);
  const who: People = { requester: requester.name, owner: owner.name, ownerTz: owner.tz };

  if (!ref) {
    if (ask.state !== "accepted" && ask.state !== "in_progress") return;
    if (!(await claimCreate(env.DB, askId))) return; // another sync is creating it
    // Re-check under the claim: a previous claimant may have finished since we loaded the ask.
    ref = await env.DB.prepare("SELECT tracker_ref FROM asks WHERE id = ?").bind(askId).first<string>("tracker_ref");
    if (ref) {
      prev = await loadSync(env.DB, askId);
    } else {
      let created;
      try {
        created = await tracker.createIssue({
          title: ask.title,
          description: buildDescription(ask, { ...who, ownerUnmapped: !owner.email }),
          dueDate: ask.deadline_at == null ? null : isoDate(ask.deadline_at, owner.tz),
          assigneeEmail: owner.email,
        });
      } catch (e) {
        await releaseClaim(env.DB, askId); // let the next sync retry right away instead of waiting out the lease
        throw e;
      }
      ref = created.ref;
      // Not touching updated_at: it is the optimistic-concurrency token for the ask.
      await env.DB
        .prepare("UPDATE asks SET tracker_ref = ?, tracker_url = ? WHERE id = ? AND tracker_ref IS NULL")
        .bind(ref, created.url, askId)
        .run();
      prev = { state: null, deadline_at: ask.deadline_at, owner_id: ask.owner_id };
      await saveSync(env.DB, askId, prev); // also clears the claim
      if (!created.assigned && owner.email) console.warn(`tracker: no tracker user for ${owner.email}`);
    }
    if (prev && ref) await releaseClaim(env.DB, askId);
  }

  let cur: SyncState = prev ?? { state: null, deadline_at: null, owner_id: null };
  for (const step of planSync(ask, cur, who)) {
    switch (step.op) {
      case "due":
        await tracker.setDueDate(ref, step.date);
        break;
      case "assign":
        if (!(await tracker.setAssignee(ref, owner.email))) {
          console.warn(`tracker: no tracker user for ${owner.email ?? ask.owner_id}`);
        }
        break;
      case "status":
        if (!(await tracker.setStatus(ref, step.to)) && step.fallbackComment) {
          await tracker.comment(ref, step.fallbackComment);
        }
        break;
      case "comment":
        await tracker.comment(ref, step.text);
        break;
      case "record":
        break;
    }
    cur = { ...cur, ...step.patch };
    await saveSync(env.DB, askId, cur);
  }
}
