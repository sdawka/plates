import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHANNEL, MONDAY_10AM, USERS, createHarness, type Harness } from "../helpers/env";
import { flatText, interactiveElements } from "../helpers/fakeSlack";
import { seedRequest } from "../helpers/seed";
import { tagAndConfirm } from "../helpers/scenario";
import type { AskRow } from "../../src/types";

let h: Harness;
beforeEach(() => void (h = createHarness()));
afterEach(() => h.dispose());

const DAY = 86_400_000;
const at = (day: number, hour = 9, minute = 0) => Date.UTC(2026, 9, day, hour, minute); // October 2026; the 19th is a Monday
const [MON, TUE, WED, THU, FRI, SAT, SUN, NEXT_MON] = [19, 20, 21, 22, 23, 24, 25, 26];

/** Confirmed request in a real thread with the given asks on bob's plate (holder = owner unless overridden). */
async function seed(asks: Partial<AskRow>[], req: Record<string, unknown> = {}) {
  const root = h.slack.addHumanMessage({ channel: CHANNEL, user: USERS.dana, text: `<@${USERS.bob}> a few things` });
  const out = await seedRequest(h, { thread_ts: root.ts, message_ts: null, ...req }, asks.map((a) => ({ state: "accepted", accepted_at: MONDAY_10AM, updated_at: MONDAY_10AM, ...a })));
  await resched(USERS.bob);
  return out.asks;
}
const resched = (user: string) => h.env.KEEPER.get(h.env.KEEPER.idFromName(user)).reschedule(user);
const reminders = (user: string = USERS.bob) => h.slack.im(user).messages.filter((m) => m.text.startsWith("Reminder:"));
const row = (id: string) => h.q("SELECT * FROM asks WHERE id = ?", id)[0]!;
const buttons = (m: { blocks?: Record<string, unknown>[] }, askId: string) =>
  interactiveElements(m.blocks?.filter((b) => b.block_id === `a:${askId}` || String(b.block_id ?? "").includes(askId))).map((e) => e.element);
const actionIds = (m: { blocks?: Record<string, unknown>[] }) => interactiveElements(m.blocks).map((e) => e.element.action_id);

describe("reminder ladder (owner, accepted with a deadline)", () => {
  it("deadline day, the next working day, then weekly; nothing in between", async () => {
    const [a] = await seed([{ title: "Q3 numbers", deadline_at: at(THU, 17) }]);
    await h.fireAlarms(at(WED));
    expect(reminders()).toHaveLength(0);

    await h.fireAlarms(at(THU));
    expect(reminders()).toHaveLength(1);
    expect(flatText(reminders()[0]!)).toContain("Q3 numbers");
    expect(row(a!.id)).toMatchObject({ reminder_stage: 1, last_reminded_at: at(THU) });

    await h.fireAlarms(at(THU, 15));
    expect(reminders()).toHaveLength(1); // same day: not again

    await h.fireAlarms(at(FRI));
    expect(reminders()).toHaveLength(2);
    expect(row(a!.id)).toMatchObject({ reminder_stage: 2 });

    await h.fireAlarms(at(NEXT_MON));
    await h.fireAlarms(at(NEXT_MON + 3));
    expect(reminders()).toHaveLength(2);
    await h.fireAlarms(at(FRI + 7)); // weekly after the last one
    expect(reminders()).toHaveLength(3);
    expect(h.errors).toEqual([]);
  });

  it("offers the owner's buttons on the reminder, and they work from the DM", async () => {
    const [a] = await seed([{ title: "Q3 numbers", deadline_at: at(THU, 17) }]);
    await h.fireAlarms(at(THU));
    const msg = reminders()[0]!;
    expect(actionIds(msg)).toEqual(["ask:accept_now", "ask:done", "ask:set_deadline", "ask:snooze"]);
    await h.click(USERS.bob, { channel: h.slack.im(USERS.bob).id, ts: msg.ts }, "ask:done", a!.id);
    expect(h.slack.lastModal().callback_id).toBe("modal:done");
    await h.submit(USERS.bob, { link: "https://docs.test/q3" });
    expect(row(a!.id).state).toBe("delivered");
    await h.fireAlarms(at(FRI));
    expect(reminders()).toHaveLength(1); // delivered asks are the requester's business now
  });

  it("a deadline on Saturday first reminds on Monday, never over the weekend", async () => {
    await seed([{ title: "Weekend thing", deadline_at: at(SAT, 12) }]);
    for (const t of [at(FRI, 20), at(SAT, 10), at(SUN, 10), at(SUN, 23)]) await h.fireAlarms(t);
    expect(reminders()).toHaveLength(0);
    await h.fireAlarms(at(NEXT_MON));
    expect(reminders()).toHaveLength(1);
  });

  it("a Friday deadline's follow-up skips the weekend", async () => {
    await seed([{ title: "Friday thing", deadline_at: at(FRI, 12) }]);
    await h.fireAlarms(at(FRI));
    await h.fireAlarms(at(SAT, 12));
    await h.fireAlarms(at(SUN, 12));
    expect(reminders()).toHaveLength(1);
    await h.fireAlarms(at(NEXT_MON));
    expect(reminders()).toHaveLength(2);
  });

  it("never outside working hours: a late alarm waits for the next window", async () => {
    await seed([{ title: "Late", deadline_at: at(THU, 17) }]);
    await h.fireAlarms(at(THU, 18)); // 18:00 is past 17:00 closing
    expect(reminders()).toHaveLength(0);
    await h.fireAlarms(at(FRI));
    expect(reminders()).toHaveLength(1);
  });

  it("an accepted ask with no deadline is reminded weekly from acceptance", async () => {
    await seed([{ title: "Someday" }]);
    await h.fireAlarms(at(NEXT_MON - 1 + 0, 9)); // Sun 25th: not yet 7 days + working day
    expect(reminders()).toHaveLength(0);
    await h.fireAlarms(at(NEXT_MON)); // Mon 26th 09:00 = 7 days after Monday 19th
    expect(reminders()).toHaveLength(1);
  });
});

describe("daily cap", () => {
  const four = () => seed([1, 2, 3, 4].map((i) => ({ title: `Thing ${i}`, deadline_at: at(THU, 17), created_at: MONDAY_10AM + i })));

  it("sends at most the cap in one DM, holds the rest for the next working day", async () => {
    await four();
    await h.env.DB.prepare("UPDATE user_prefs SET max_reminders_per_day = 2 WHERE user_id = ?").bind(USERS.bob).run();
    await h.fireAlarms(at(THU));
    expect(reminders()).toHaveLength(1);
    const first = flatText(reminders()[0]!);
    expect(first).toContain("Thing 1");
    expect(first).toContain("Thing 2");
    expect(first).not.toContain("Thing 3");
    expect(h.q("SELECT reminders_sent FROM user_prefs WHERE user_id = ?", USERS.bob)[0]).toEqual({ reminders_sent: 2 });

    await h.fireAlarms(at(THU, 16)); // still capped today
    expect(reminders()).toHaveLength(1);
    await h.fireAlarms(at(FRI));
    expect(reminders()).toHaveLength(2);
    const second = flatText(reminders()[1]!);
    expect(second).toContain("Thing 3");
    expect(second).toContain("Thing 4");
    expect(h.errors).toEqual([]);
  });

  it("the digest mentions what was held back when reminders ran earlier that day", async () => {
    await four();
    await h.env.DB.prepare("UPDATE user_prefs SET max_reminders_per_day = 2, digest_time = '12:00' WHERE user_id = ?").bind(USERS.bob).run();
    await resched(USERS.bob);
    await h.fireAlarms(at(THU)); // reminders at 09:00
    await h.fireAlarms(at(THU, 12)); // digest at 12:00
    const digest = h.slack.dmTexts(USERS.bob).filter((t) => t.includes("daily Plates digest")).at(-1)!;
    expect(digest).toContain("2 reminders held back today");
  });

  it("with default settings the same-morning digest says how many reminders were held back", async () => {
    await four();
    await h.env.DB.prepare("UPDATE user_prefs SET max_reminders_per_day = 2 WHERE user_id = ?").bind(USERS.bob).run();
    await h.fireAlarms(at(THU));
    const digest = h.slack.dmTexts(USERS.bob).filter((t) => t.includes("daily Plates digest")).at(-1)!;
    expect(digest).toContain("2 reminders held back today");
  });
});

describe("lighter reminders", () => {
  it("a proposed ask: the next working day, then weekly, with accept/reject buttons", async () => {
    const [a] = await seed([{ title: "New thing", state: "proposed", accepted_at: null }]);
    await h.fireAlarms(at(MON, 16));
    expect(reminders()).toHaveLength(0);
    await h.fireAlarms(at(TUE));
    expect(reminders()).toHaveLength(1);
    const ids = actionIds(reminders()[0]!);
    expect(ids.slice(0, 3)).toEqual(["ask:accept_now", "ask:accept_later", "ask:reject"]);
    expect(ids.at(-1)).toBe("ask:overflow");
    await h.fireAlarms(at(TUE + 6));
    expect(reminders()).toHaveLength(1);
    await h.fireAlarms(at(TUE + 7));
    expect(reminders()).toHaveLength(2);
    expect(row(a!.id).reminder_stage).toBe(2);
  });

  it("a rejected ask reminds the requester, with Close / Put back / Redirect", async () => {
    await seed([{ title: "Declined", state: "rejected", holder_id: USERS.dana, last_note: "not mine" }]);
    await resched(USERS.dana);
    await h.fireAlarms(at(TUE));
    expect(reminders(USERS.dana)).toHaveLength(1);
    expect(actionIds(reminders(USERS.dana)[0]!)).toEqual(["ask:close", "ask:put_back", "ask:redirect"]);
    expect(reminders()).toHaveLength(0); // bob is not nagged about his own rejection
  });

  it("snoozed and delivered asks are never reminded", async () => {
    await seed([
      { title: "Sleeping", state: "snoozed", snoozed_from: "accepted", snoozed_until: at(NEXT_MON + 10), snooze_count: 1 },
      { title: "Handed over", state: "delivered", holder_id: USERS.dana },
    ]);
    await h.fireAlarms(at(NEXT_MON));
    await h.fireAlarms(at(NEXT_MON + 5));
    expect(reminders()).toHaveLength(0);
    expect(reminders(USERS.dana)).toHaveLength(0);
  });
});

describe("asks snoozed three times", () => {
  const due = { accepted_at: MONDAY_10AM - 8 * DAY }; // weekly ladder already due

  it("accepted: deadline, redirect, reject first; snooze is demoted to 'Snooze anyway'", async () => {
    const [a] = await seed([{ title: "Always later", snooze_count: 3, ...due }]);
    await h.fireAlarms(MONDAY_10AM);
    const msg = reminders()[0]!;
    expect(actionIds(msg)).toEqual(["ask:set_deadline", "ask:redirect", "ask:reject", "ask:snooze"]);
    expect(buttons(msg, a!.id).map((e) => (e.text as { text: string }).text)).toEqual(["Set deadline", "Hand off", "Reject", "Snooze anyway"]);
    expect(flatText(msg)).toContain("Snoozed 3 times. Pick a deadline, hand it off, or say no?");
    expect(flatText(msg)).toContain("💤×3");
  });

  it("proposed: 'Set deadline' is accept-later with the label swapped", async () => {
    await seed([{ title: "Never accepted", state: "proposed", snooze_count: 3, updated_at: MONDAY_10AM - 2 * DAY, accepted_at: null }]);
    await h.fireAlarms(MONDAY_10AM);
    const msg = reminders()[0]!;
    expect(actionIds(msg)).toEqual(["ask:accept_later", "ask:redirect", "ask:reject", "ask:snooze"]);
    expect(interactiveElements(msg.blocks).map((e) => (e.element.text as { text: string }).text)).toEqual(["Set deadline", "Hand off", "Reject", "Snooze anyway"]);
  });

  it("two snoozes is still the ordinary set, with no nudge text", async () => {
    await seed([{ title: "Twice", snooze_count: 2, ...due }]);
    await h.fireAlarms(MONDAY_10AM);
    const msg = reminders()[0]!;
    expect(actionIds(msg)[0]).not.toBe("ask:set_deadline");
    expect(flatText(msg)).not.toContain("Snoozed 2 times");
    expect(interactiveElements(msg.blocks).map((e) => (e.element.text as { text: string }).text)).toContain("Snooze");
  });

  it("the nudge's Set deadline button opens the deadline modal", async () => {
    const [a] = await seed([{ title: "Always later", snooze_count: 3, ...due }]);
    await h.fireAlarms(MONDAY_10AM);
    const msg = reminders()[0]!;
    await h.click(USERS.bob, { channel: h.slack.im(USERS.bob).id, ts: msg.ts }, "ask:set_deadline", a!.id);
    expect(h.slack.lastModal().callback_id).toBe("modal:set_deadline");
  });
});

describe("bump", () => {
  it("the requester bumps from Home: the owner is DMed, and only once per 20 hours", async () => {
    const t = await tagAndConfirm(h);
    const id = h.asks()[0]!.id as string;
    await h.openHome(USERS.dana);
    const before = h.slack.dmTexts(USERS.bob).length;
    expect((await h.clickHome(USERS.dana, "askx:bump", id)).status).toBe(200);
    const dm = h.slack.im(USERS.bob).messages.slice(before);
    expect(dm).toHaveLength(1);
    expect(flatText(dm[0]!)).toContain(`<@${USERS.dana}> bumped`);
    expect(flatText(dm[0]!)).toContain("Send the Q3 numbers");
    expect(actionIds(dm[0]!)).toContain("ask:accept_now");
    expect(h.events(id).at(-1)).toMatchObject({ kind: "bump", actor_id: USERS.dana, via: "home" });
    expect(t.requestId).toBeTruthy();

    // Home now says "bumped today" and drops the button, so retry from the thread card's menu
    expect(actionIds({ blocks: h.slack.homeViews.get(USERS.dana)!.blocks })).not.toContain("askx:bump");
    expect(flatText(h.slack.homeViews.get(USERS.dana)!)).toContain("bumped today");
    const card = { channel: CHANNEL, ts: t.card.ts };
    h.clock.advance(19 * 3_600_000);
    await h.choose(USERS.dana, card, "ask:overflow", `askx:bump|${id}`);
    expect(h.slack.ephemerals.filter((e) => e.user === USERS.dana).map((e) => e.text)).toEqual(["You've already bumped this today."]);
    expect(h.slack.im(USERS.bob).messages.slice(before)).toHaveLength(1);

    h.clock.advance(2 * 3_600_000);
    await h.choose(USERS.dana, card, "ask:overflow", `askx:bump|${id}`);
    expect(h.slack.im(USERS.bob).messages.slice(before)).toHaveLength(2);
    expect(h.errors).toEqual([]);
  });

  it("the owner cannot bump their own ask, and a bump on a delivered ask is refused", async () => {
    await tagAndConfirm(h);
    const id = h.asks()[0]!.id as string;
    await h.openHome(USERS.bob);
    await h.ingress.interaction(h.ingress.blockActions({ user: USERS.bob, blocks: [{ type: "actions", block_id: "x", elements: [{ type: "button", action_id: "askx:bump", value: id, text: { type: "plain_text", text: "Bump" } }] }], actionId: "askx:bump", value: id, where: { home: USERS.bob } }));
    expect(h.slack.dmTexts(USERS.bob).at(-1)).toBe("Only the person who asked can bump it.");
    expect(h.events(id).filter((e) => e.kind === "bump")).toHaveLength(0);
  });

  it("the thread card's ask menu has Bump for the requester only", async () => {
    const t = await tagAndConfirm(h);
    const id = h.asks()[0]!.id as string;
    const card = { channel: CHANNEL, ts: t.card.ts };
    await h.choose(USERS.dana, card, "ask:overflow", `askx:bump|${id}`);
    expect(h.events(id).at(-1)).toMatchObject({ kind: "bump", via: "button" });
  });
});
