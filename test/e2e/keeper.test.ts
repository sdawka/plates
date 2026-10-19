import { afterEach, describe, expect, it } from "vitest";
import { CHANNEL, MONDAY_10AM, USERS, createHarness, type Harness } from "../helpers/env";
import { API_URL, flatText } from "../helpers/fakeSlack";
import { json } from "../helpers/net";
import { seedRequest } from "../helpers/seed";
import { tagAndConfirm, tagThread, text } from "../helpers/scenario";

let h: Harness;
afterEach(() => h.dispose());

const HOUR = 3_600_000;
const ask = () => h.asks()[0]!;
const dmRef = (user: string) => ({ channel: h.slack.im(user).id, ts: h.slack.im(user).messages.at(-1)!.ts });

describe("snooze and the keeper alarm", () => {
  it("snooze 2h keeps the ask on the owner's plate and the keeper wakes it at the right time", async () => {
    h = createHarness();
    const t = await tagAndConfirm(h);
    const id = ask().id as string;
    await h.click(USERS.bob, dmRef(USERS.bob), "ask:accept_now", id);
    // The DM only offers accept/done/reject/send back; snooze lives in the thread message menu.
    await h.choose(USERS.bob, { channel: CHANNEL, ts: t.card.ts }, "ask:overflow", `ask:snooze|${id}`);
    expect(h.slack.lastModal().callback_id).toBe("modal:snooze");
    await h.submit(USERS.bob, { preset: "2h" });

    const until = MONDAY_10AM + 2 * HOUR;
    expect(ask()).toMatchObject({ state: "snoozed", snoozed_from: "in_progress", snoozed_until: until, snooze_count: 1, holder_id: USERS.bob });
    expect(text(h.slack.message(CHANNEL, t.card.ts))).toContain("💤 until");

    // First alarms: the (overdue) morning digest. Then nothing until the snooze ends.
    await h.fireAlarms(MONDAY_10AM);
    expect(await h.keepers.alarmOf(USERS.bob)).toBe(until);
    await h.fireAlarms(until - 1);
    expect(ask().state).toBe("snoozed");
    expect(await h.fireAlarms(until)).toContain(USERS.bob);
    expect(ask()).toMatchObject({ state: "in_progress", snoozed_until: null, snoozed_from: null });
    expect(h.events(id).at(-1)).toMatchObject({ kind: "wake", actor_id: "system", via: "system" });
    expect(text(h.slack.message(CHANNEL, t.card.ts))).toContain("in progress");
    expect(h.errors).toEqual([]);
  });

  it("snoozing again before the wake time moves the alarm", async () => {
    h = createHarness();
    await tagAndConfirm(h);
    const id = ask().id as string;
    const msg = h.slack.message(CHANNEL, h.requests()[0]!.message_ts as string);
    const at = { channel: CHANNEL, ts: msg.ts };
    await h.choose(USERS.bob, at, "ask:overflow", `ask:snooze|${id}`);
    await h.submit(USERS.bob, { preset: "2h" });
    h.clock.advance(HOUR);
    await h.choose(USERS.bob, at, "ask:overflow", `ask:snooze|${id}`);
    await h.submit(USERS.bob, { preset: "2h" });
    expect(ask()).toMatchObject({ snooze_count: 2, snoozed_until: MONDAY_10AM + 3 * HOUR });
    await h.fireAlarms(MONDAY_10AM); // digest
    expect(await h.keepers.alarmOf(USERS.bob)).toBe(MONDAY_10AM + 3 * HOUR);
  });

  it("creates prefs from the user's Slack time zone on first sight", async () => {
    h = createHarness({ users: [
      { id: USERS.dana, name: "dana", tz: "America/Los_Angeles" },
      { id: USERS.bob, name: "bob", tz: "Europe/Berlin" },
      { id: USERS.tara, name: "tara" },
    ] });
    await tagThread(h);
    expect(h.q("SELECT user_id, tz FROM user_prefs ORDER BY user_id")).toEqual([
      { user_id: USERS.bob, tz: "Europe/Berlin" },
      { user_id: USERS.dana, tz: "America/Los_Angeles" },
    ]);
  });
});

describe("unconfirmed requests: nudge, discard, Home, confirm", () => {
  it("nudges both people on the next working day, discards the day after, then a Home button confirms", async () => {
    h = createHarness({ users: [
      { id: USERS.dana, name: "dana", tz: "America/Los_Angeles" },
      { id: USERS.bob, name: "bob", tz: "UTC" },
      { id: USERS.tara, name: "tara", tz: "UTC" },
    ] });
    const t = await tagThread(h);
    const reqId = t.requestId;
    expect(h.requests()[0]!.status).toBe("pending_confirmation");

    // Bob's keeper (UTC) is the first to reach "next working day, 09:00": Tuesday.
    const tueNine = Date.UTC(2026, 9, 20, 9, 0);
    const wedNine = Date.UTC(2026, 9, 21, 9, 0);
    await h.fireAlarms(tueNine - 1);
    expect(h.requests()[0]!.nudged_at).toBeNull();
    const fired = await h.fireAlarms(tueNine);
    expect(fired).toContain(USERS.bob);
    expect(h.requests()[0]!.nudged_at).toBe(tueNine);

    for (const u of [USERS.dana, USERS.bob]) {
      const dm = h.slack.im(u).messages.find((m) => flatText(m).includes("Still waiting on a ✅"))!;
      expect(dm, `${u} nudged`).toBeTruthy();
      expect(JSON.stringify(dm.blocks)).toContain(`"value":"${reqId}"`);
    }
    // Dana's own keeper fires later (09:00 Pacific) and must not nudge again.
    await h.fireAlarms(Date.UTC(2026, 9, 20, 17, 0));
    expect(h.slack.dmTexts(USERS.dana).filter((x) => x.includes("Still waiting on a ✅"))).toHaveLength(1);
    expect(h.requests()[0]!.status).toBe("pending_confirmation");

    // The following working day: discarded, card says so, Home lists it under Unconfirmed.
    await h.fireAlarms(wedNine);
    expect(h.requests()[0]!.status).toBe("discarded");
    expect(text(h.slack.message(CHANNEL, t.card.ts))).toContain("This request was not confirmed");
    await h.openHome(USERS.dana);
    const home = flatText(h.slack.homeViews.get(USERS.dana)!);
    expect(home).toContain("Unconfirmed");
    expect(home).toContain("Send the Q3 numbers");

    // Confirm from Home.
    const res = await h.clickHome(USERS.dana, "req:confirm", reqId);
    expect(res.status).toBe(200);
    expect(h.requests()[0]).toMatchObject({ status: "confirmed", confirmed_by: USERS.dana });
    expect(h.asks()).toHaveLength(1);
    expect(text(h.slack.im(USERS.bob).messages.at(-1)!)).toContain("asked you for 1 thing");
    expect(flatText(h.slack.homeViews.get(USERS.dana)!)).toContain("No unconfirmed requests");
    expect(h.errors).toEqual([]);
  });

  it("a request confirmed before the nudge is never nudged", async () => {
    h = createHarness();
    await tagAndConfirm(h);
    await h.fireAlarms(Date.UTC(2026, 9, 21, 12, 0));
    expect(h.slack.dmTexts(USERS.dana).join("\n")).not.toContain("Still waiting");
    expect(h.requests()[0]!.nudged_at).toBeNull();
  });

  it("on a Friday the nudge waits for Monday", async () => {
    h = createHarness({ now: Date.UTC(2026, 9, 23, 15, 0) }); // Friday 15:00 UTC
    await tagThread(h);
    await h.fireAlarms(Date.UTC(2026, 9, 24, 12, 0)); // Saturday
    await h.fireAlarms(Date.UTC(2026, 9, 25, 12, 0)); // Sunday
    expect(h.requests()[0]!.nudged_at).toBeNull();
    await h.fireAlarms(Date.UTC(2026, 9, 26, 9, 0));
    expect(h.requests()[0]!.nudged_at).toBe(Date.UTC(2026, 9, 26, 9, 0));
  });
});

// regression: was a src bug, now fixed
it("records via=home when a request is confirmed from the Home tab", async () => {
  h = createHarness();
  const t = await tagThread(h);
  await h.fireAlarms(Date.UTC(2026, 9, 20, 9, 0));
  await h.fireAlarms(Date.UTC(2026, 9, 21, 9, 0));
  await h.openHome(USERS.dana);
  await h.clickHome(USERS.dana, "req:confirm", t.requestId);
  expect(h.requests()[0]!.confirmed_via).toBe("home");
});

// ---------- keeper robustness ----------

const MIN = 60_000;
const FRI_10AM = MONDAY_10AM - 3 * 24 * HOUR;
const prefsRow = (u: string) => h.q("SELECT * FROM user_prefs WHERE user_id = ?", u)[0]!;

/** Routes chat.postMessage through `hook`; the hook may return a Response to replace Slack's answer. */
function interceptPostMessage(hook: (req: Request) => Response | void | Promise<Response | void>) {
  h.net.route(`${API_URL}/chat.postMessage`, async (req) => {
    const early = await hook(req.clone());
    if (early) return early;
    return (h.slack as unknown as { handleApi(r: Request): Promise<Response> }).handleApi(req);
  });
}

/** A proposed ask on bob's plate whose first reminder is due at MONDAY_10AM. */
async function seedDueReminder() {
  const { asks } = await seedRequest(h, {}, [{ state: "proposed", updated_at: FRI_10AM, created_at: FRI_10AM }]);
  await h.keepers.get(h.env.KEEPER.idFromName(USERS.bob) as never).reschedule(USERS.bob);
  return asks[0]!.id;
}

describe("keeper: failed sends and concurrent writes", () => {
  it("a failed reminder DM leaves the ladder and daily count alone, and the next run sends it", async () => {
    h = createHarness();
    const id = await seedDueReminder();
    let failing = true;
    interceptPostMessage(() => (failing ? json({ ok: false, error: "fatal_error" }) : undefined));

    await h.fireAlarms(MONDAY_10AM);
    expect(h.q("SELECT reminder_stage, last_reminded_at FROM asks WHERE id = ?", id)[0]).toEqual({ reminder_stage: 0, last_reminded_at: null });
    expect(prefsRow(USERS.bob).reminders_sent ?? 0).toBe(0);
    expect(h.slack.dmTexts(USERS.bob)).toHaveLength(0);
    expect(await h.keepers.alarmOf(USERS.bob)).toBeGreaterThanOrEqual(MONDAY_10AM + 5 * MIN);

    failing = false;
    await h.fireAlarms(MONDAY_10AM + 6 * MIN);
    expect(h.q("SELECT reminder_stage, last_reminded_at FROM asks WHERE id = ?", id)[0]).toEqual({
      reminder_stage: 1,
      last_reminded_at: MONDAY_10AM + 6 * MIN,
    });
    expect(prefsRow(USERS.bob).reminders_sent).toBe(1);
    expect(h.slack.dmTexts(USERS.bob).length).toBeGreaterThan(0);
  });

  it("a snooze that cannot be woken does not re-arm the alarm immediately", async () => {
    h = createHarness();
    const { asks } = await seedRequest(h, {}, [{ state: "snoozed", snoozed_from: "accepted", snoozed_until: MONDAY_10AM - HOUR }]);
    // Race: another writer touches the ask between the keeper's read and its save, so the wake is refused.
    const real = h.env.DB;
    let raced = false;
    (h.env as { DB: D1Database }).DB = new Proxy(real, {
      get(t, k) {
        const v = (t as never)[k] as unknown;
        if (k !== "batch") return typeof v === "function" ? v.bind(t) : v;
        return async (stmts: D1PreparedStatement[]) => {
          if (!raced) {
            raced = true;
            await real.prepare("UPDATE asks SET updated_at = updated_at + 1 WHERE id = ?").bind(asks[0]!.id).run();
          }
          return real.batch(stmts);
        };
      },
    });
    await h.keepers.get(h.env.KEEPER.idFromName(USERS.bob) as never).reschedule(USERS.bob);
    await h.fireAlarms(MONDAY_10AM);
    expect(raced).toBe(true);
    expect(h.asks()[0]!.state).toBe("snoozed");
    expect(await h.keepers.alarmOf(USERS.bob)).toBeGreaterThanOrEqual(MONDAY_10AM + 5 * MIN);

    // After the backoff the wake goes through.
    await h.fireAlarms(MONDAY_10AM + 6 * MIN);
    expect(h.asks()[0]).toMatchObject({ state: "accepted", snoozed_until: null });
  });

  it("settings saved while a digest is being sent survive it", async () => {
    h = createHarness();
    await seedRequest(h, {}, [{ state: "accepted", accepted_at: MONDAY_10AM }]);
    await h.keepers.get(h.env.KEEPER.idFromName(USERS.bob) as never).reschedule(USERS.bob);
    interceptPostMessage(async () => {
      await h.env.DB.prepare("UPDATE user_prefs SET max_reminders_per_day = 7, work_end_hour = 18 WHERE user_id = ?").bind(USERS.bob).run();
    });
    await h.fireAlarms(MONDAY_10AM);
    expect(prefsRow(USERS.bob)).toMatchObject({ max_reminders_per_day: 7, work_end_hour: 18, last_digest_at: MONDAY_10AM });
  });

  it("settings saved while a reminder is being sent survive it", async () => {
    h = createHarness();
    await seedDueReminder();
    interceptPostMessage(async () => {
      await h.env.DB.prepare("UPDATE user_prefs SET max_reminders_per_day = 7, work_end_hour = 18 WHERE user_id = ?").bind(USERS.bob).run();
    });
    await h.fireAlarms(MONDAY_10AM);
    expect(prefsRow(USERS.bob)).toMatchObject({ max_reminders_per_day: 7, work_end_hour: 18, reminders_sent: 1 });
  });
});
