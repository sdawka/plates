import { afterEach, describe, expect, it } from "vitest";
import { CHANNEL, MONDAY_10AM, USERS, createHarness, type Harness } from "../helpers/env";
import { flatText } from "../helpers/fakeSlack";
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

// src bug: src/slack/interactions.ts confirmRequestAction() hardcodes via "button", so a confirm from the
// Home tab is recorded as "button" although viaOf(p) would say "home". Fix: pass viaOf(p) through.
it("records via=home when a request is confirmed from the Home tab", async () => {
  h = createHarness();
  const t = await tagThread(h);
  await h.fireAlarms(Date.UTC(2026, 9, 20, 9, 0));
  await h.fireAlarms(Date.UTC(2026, 9, 21, 9, 0));
  await h.openHome(USERS.dana);
  await h.clickHome(USERS.dana, "req:confirm", t.requestId);
  expect(h.requests()[0]!.confirmed_via).toBe("home");
});
