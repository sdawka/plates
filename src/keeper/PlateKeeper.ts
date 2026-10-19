// One instance per Slack user (idFromName(userId)). Owns that user's alarms: snooze wake-ups,
// the daily digest and unconfirmed-request nudges. All work is idempotent so retries are safe.
import { DurableObject } from "cloudflare:workers";
import { discardRequest, applyAction } from "../domain/service";
import {
  defaultPrefs,
  getPrefs,
  getRequest,
  listDueSnoozes,
  listPendingToConfirm,
  listPlate,
  nextSnoozeWake,
  updateRequest,
  upsertPrefs,
} from "../domain/repo";
import { dispatch } from "../effects";
import { slackCall } from "../slack/api";
import { TransitionError, type Effect, type Env, type UserPrefsRow } from "../types";
import { buildDigest } from "./digest";
import { computeDue, nextAlarmAt, type JobKind, type Snapshot } from "./schedule";
import { isValidTimeZone } from "./time";

const USER_KEY = "userId";
const BACKOFF_KEY = "backoffUntil";
const BACKOFF_MS = 5 * 60_000;

export class PlateKeeper extends DurableObject<Env> {
  /** Recompute this user's next alarm (snooze wake-ups, digest, unconfirmed nudges). Idempotent. */
  async reschedule(userId: string): Promise<void> {
    await this.ctx.storage.put(USER_KEY, userId);
    await this.armAlarm(userId);
  }

  async alarm(): Promise<void> {
    const userId = await this.ctx.storage.get<string>(USER_KEY);
    if (!userId) return;

    const failed = await this.runDueJobs(userId);
    if (failed) await this.ctx.storage.put(BACKOFF_KEY, Date.now() + BACKOFF_MS);
    else await this.ctx.storage.delete(BACKOFF_KEY);
    await this.armAlarm(userId);
  }

  // ---------- alarm computation ----------

  private async snapshot(userId: string): Promise<Snapshot> {
    const prefs = await this.ensurePrefs(userId);
    const [wake, pendingRequests] = await Promise.all([
      nextSnoozeWake(this.env.DB, userId),
      listPendingToConfirm(this.env.DB, userId),
    ]);
    return { now: Date.now(), prefs, nextSnoozeWake: wake, pendingRequests };
  }

  private async armAlarm(userId: string): Promise<void> {
    const next = nextAlarmAt(await this.snapshot(userId));
    if (next == null) return this.ctx.storage.deleteAlarm();
    const backoff = (await this.ctx.storage.get<number>(BACKOFF_KEY)) ?? 0;
    await this.ctx.storage.setAlarm(Math.max(next, backoff));
  }

  /** Prefs row, created on first sight from the user's Slack time zone. Falls back to UTC without persisting. */
  private async ensurePrefs(userId: string): Promise<UserPrefsRow> {
    const prefs = await getPrefs(this.env.DB, userId);
    if (prefs.updated_at !== 0) return prefs;
    try {
      const res = await slackCall<{ user?: { tz?: string } }>(this.env, "users.info", { user: userId });
      const tz = res.user?.tz;
      const created = { ...defaultPrefs(userId), tz: tz && isValidTimeZone(tz) ? tz : "UTC" };
      await upsertPrefs(this.env.DB, created);
      return created;
    } catch (err) {
      console.error(`keeper ${userId}: could not create prefs`, err);
      return prefs;
    }
  }

  // ---------- job execution ----------

  /** Runs everything due. Returns true if any job failed unexpectedly. */
  private async runDueJobs(userId: string): Promise<boolean> {
    const snap = await this.snapshot(userId);
    let failed = false;
    for (const job of computeDue(snap)) {
      try {
        await this.runJob(userId, job, snap);
      } catch (err) {
        failed = true;
        console.error(`keeper ${userId}: job ${job.kind} failed`, err);
      }
    }
    return failed;
  }

  private async runJob(userId: string, job: JobKind, snap: Snapshot): Promise<void> {
    switch (job.kind) {
      case "wake":
        return this.wakeSnoozes(userId, snap.now);
      case "digest":
        return this.sendDigest(userId, snap.prefs, snap.now);
      case "nudge":
        return this.nudge(job.requestId, snap.now);
      case "discard":
        return this.discard(job.requestId);
    }
  }

  private async wakeSnoozes(userId: string, now: number): Promise<void> {
    for (const ask of await listDueSnoozes(this.env.DB, userId, now)) {
      try {
        const effects = await applyAction(this.env, ask.id, { kind: "wake" }, "system", "system");
        await dispatch(this.env, effects);
      } catch (err) {
        // The ask changed meanwhile: it is no longer our business.
        if (!(err instanceof TransitionError)) throw err;
        console.warn(`keeper ${userId}: skip wake of ${ask.id}: ${err.message}`);
      }
    }
  }

  private async sendDigest(userId: string, prefs: UserPrefsRow, now: number): Promise<void> {
    const digest = buildDigest(userId, await listPlate(this.env.DB, userId));
    if (digest) await slackCall(this.env, "chat.postMessage", { channel: userId, text: digest.text, blocks: digest.blocks });
    await upsertPrefs(this.env.DB, { ...prefs, last_digest_at: now });
  }

  /** Whichever participant's keeper fires first claims nudged_at and notifies both. */
  private async nudge(requestId: string, now: number): Promise<void> {
    const req = await getRequest(this.env.DB, requestId);
    if (!req || req.status !== "pending_confirmation" || req.nudged_at != null) return;
    await updateRequest(this.env.DB, req.id, { nudged_at: now });
    const people = [...new Set([req.requester_id, req.owner_id].filter((u): u is string => !!u))];
    const effects: Effect[] = people.map((userId) => ({ kind: "dm", userId, template: "confirm_nudge", requestId: req.id }));
    await dispatch(this.env, effects);
  }

  private async discard(requestId: string): Promise<void> {
    await dispatch(this.env, await discardRequest(this.env, requestId));
  }
}
