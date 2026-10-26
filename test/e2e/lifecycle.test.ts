import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHANNEL, USERS, createHarness, type Harness } from "../helpers/env";
import { tagAndConfirm, text } from "../helpers/scenario";

let h: Harness;
beforeEach(() => void (h = createHarness()));
afterEach(() => h.dispose());

const ask = () => h.asks()[0]!;
const card = (t: { card: { ts: string } }) => ({ channel: CHANNEL, ts: t.card.ts });
const dmRef = (user: string, i = -1) => {
  const m = h.slack.im(user).messages.at(i)!;
  return { channel: h.slack.im(user).id, ts: m.ts };
};
const liveText = (t: { card: { ts: string } }) => text(h.slack.message(CHANNEL, t.card.ts));
const weekday = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });

describe("the DM a button sat on settles", () => {
  const blocksOf = (ref: { channel: string; ts: string }) => h.slack.message(ref.channel, ref.ts).blocks ?? [];
  const askButtons = (ref: { channel: string; ts: string }) => blocksOf(ref).filter((b) => b.block_id === `a:${ask().id}` && b.type === "actions");

  it("accept now replaces the buttons with what happened and the new status", async () => {
    await tagAndConfirm(h);
    const ref = dmRef(USERS.bob);
    expect(askButtons(ref)).toHaveLength(1);
    await h.click(USERS.bob, ref, "ask:accept_now", ask().id as string);
    const line = JSON.stringify(blocksOf(ref).find((b) => b.block_id === `a:${ask().id}:status`));
    expect(line).toContain("You're on it");
    expect(line).toContain("in progress");
    // The next moves replace Accept: Done is there, Accept is gone.
    const buttons = JSON.stringify(askButtons(ref));
    expect(buttons).toContain("ask:done");
    expect(buttons).not.toContain("ask:accept_now");

    await h.click(USERS.bob, ref, "ask:done", ask().id as string);
    await h.submit(USERS.bob, {});
    expect(blocksOf(ref).filter((b) => b.block_id === `a:${ask().id}:status`)).toHaveLength(1);
    expect(JSON.stringify(blocksOf(ref))).toContain("Marked done");
    expect(askButtons(ref)).toHaveLength(0); // now on Dana's plate: nothing left for Bob here
    expect(h.errors).toEqual([]);
  });

  it("a modal action settles the DM when the modal is submitted, not before", async () => {
    await tagAndConfirm(h);
    const ref = dmRef(USERS.bob);
    await h.click(USERS.bob, ref, "ask:accept_later", ask().id as string);
    expect(askButtons(ref)).toHaveLength(1);
    await h.submit(USERS.bob, { date: "2026-10-22" });
    expect(JSON.stringify(askButtons(ref))).not.toContain("ask:accept_later");
    expect(JSON.stringify(blocksOf(ref))).toContain("Accepted");
  });

  it("a denied click leaves the buttons alone", async () => {
    await tagAndConfirm(h);
    const ref = dmRef(USERS.bob);
    const before = JSON.stringify(blocksOf(ref));
    await h.click(USERS.dana, ref, "ask:accept_now", ask().id as string);
    expect(JSON.stringify(blocksOf(ref))).toBe(before);
  });
});

describe("owner accepts", () => {
  it("accept now from the DM button moves the ask in progress", async () => {
    const t = await tagAndConfirm(h);
    expect((await h.click(USERS.bob, dmRef(USERS.bob), "ask:accept_now", ask().id as string)).status).toBe(200);
    expect(ask()).toMatchObject({ state: "in_progress", holder_id: USERS.bob });
    expect(liveText(t)).toContain("in progress");
    expect(h.events(ask().id as string).map((e) => [e.kind, e.via, e.actor_id])).toEqual([["accept_now", "dm", USERS.bob]]);
    expect(h.errors).toEqual([]);
  });

  it("accept later opens a modal; submitting a date DMs the requester the deadline", async () => {
    const t = await tagAndConfirm(h);
    await h.click(USERS.bob, dmRef(USERS.bob), "ask:accept_later", ask().id as string);

    const opened = h.slack.callsTo("views.open");
    expect(opened).toHaveLength(1);
    const modal = h.slack.lastModal();
    expect(modal.callback_id).toBe("modal:accept_later");
    expect(JSON.parse(modal.private_metadata)).toEqual({ askId: ask().id, via: "dm", msg: dmRef(USERS.bob) });
    expect(modal.blocks.filter((b) => b.type === "input").map((b) => b.block_id)).toEqual(["date"]);

    const res = await h.submit(USERS.bob, { date: "2026-10-22" });
    expect(res).toEqual({ status: 200, body: null });
    expect(ask()).toMatchObject({ state: "accepted" });
    expect(ask().deadline_at).toBe(Date.UTC(2026, 9, 22, 23, 59));

    const dm = h.slack.dmTexts(USERS.dana).at(-1)!;
    expect(dm).toContain(`<@${USERS.bob}> expects`);
    expect(dm).toContain("2026-10-22");
    expect(liveText(t)).toContain("accepted · expected");
  });

  it("a past date is rejected inside the modal on the date field", async () => {
    await tagAndConfirm(h);
    await h.click(USERS.bob, dmRef(USERS.bob), "ask:accept_later", ask().id as string);
    const res = await h.submit(USERS.bob, { date: "2026-10-01" });
    expect(res.body).toEqual({ response_action: "errors", errors: { date: "Pick a date that isn't in the past." } });
    expect(ask().state).toBe("proposed");
  });

  it("moving the deadline tells the requester 'Thu -> Mon'", async () => {
    const t = await tagAndConfirm(h);
    await h.click(USERS.bob, dmRef(USERS.bob), "ask:accept_later", ask().id as string);
    await h.submit(USERS.bob, { date: "2026-10-22" });
    expect(weekday("2026-10-22")).toBe("Thu");

    h.clock.advance(60_000);
    await h.choose(USERS.bob, card(t), "ask:overflow", `ask:set_deadline|${ask().id}`);
    const modal = h.slack.lastModal();
    expect(modal.callback_id).toBe("modal:set_deadline");
    const dateInput = modal.blocks.find((b) => b.block_id === "date")!.element as { initial_date?: string };
    expect(dateInput.initial_date).toBe("2026-10-22");

    await h.submit(USERS.bob, { date: "2026-10-26" });
    expect(weekday("2026-10-26")).toBe("Mon");
    expect(ask()).toMatchObject({ deadline_change_count: 1 });
    const dm = h.slack.dmTexts(USERS.dana).at(-1)!;
    expect(dm).toMatch(/moved .*: <!date\^\d+\^\{date_short_pretty\}\|2026-10-22> → <!date\^\d+\^\{date_short_pretty\}\|2026-10-26>/);
    expect(liveText(t)).toContain("moved ×1");
    expect(h.errors).toEqual([]);
  });
});

describe("delivery, rejection and closing", () => {
  it("done -> delivered DM to the requester -> close", async () => {
    const t = await tagAndConfirm(h);
    const id = ask().id as string;
    await h.click(USERS.bob, dmRef(USERS.bob), "ask:accept_now", id);
    await h.click(USERS.bob, dmRef(USERS.bob), "ask:done", id);
    expect(h.slack.lastModal().callback_id).toBe("modal:done");
    await h.submit(USERS.bob, { link: "https://docs.example.com/q3", note: "numbers attached" });

    expect(ask()).toMatchObject({ state: "delivered", holder_id: USERS.dana, done_link: "https://docs.example.com/q3" });
    const dm = h.slack.im(USERS.dana).messages.at(-1)!;
    expect(text(dm)).toContain("delivered");
    expect(text(dm)).toContain("https://docs.example.com/q3");
    expect(text(dm)).toContain("numbers attached");
    expect(liveText(t)).toContain("delivered — waiting on <@UDANA> to close");

    await h.click(USERS.dana, dmRef(USERS.dana), "ask:close", id);
    expect(ask()).toMatchObject({ state: "closed" });
    expect(ask().closed_at).not.toBeNull();
    expect(liveText(t)).toContain("closed");
    expect(h.events(id).map((e) => e.kind)).toEqual(["accept_now", "done", "close"]);
    expect(h.errors).toEqual([]);
  });

  it("a bad link is flagged on the link field", async () => {
    await tagAndConfirm(h);
    await h.choose(USERS.bob, dmRef(USERS.bob), "ask:overflow", `ask:done|${ask().id as string}`);
    const res = await h.submit(USERS.bob, { link: "not a url" });
    expect(res.body).toEqual({ response_action: "errors", errors: { link: "Enter a full link starting with http:// or https://" } });
  });

  it("only the requester can close: the owner's attempt is denied with an ephemeral message", async () => {
    const t = await tagAndConfirm(h);
    const id = ask().id as string;
    await h.choose(USERS.bob, dmRef(USERS.bob), "ask:overflow", `ask:done|${id}`);
    await h.submit(USERS.bob, {});
    expect(ask().state).toBe("delivered");

    // The live thread message offers the union of both people's actions, so the owner can click Close.
    await h.choose(USERS.bob, card(t), "ask:overflow", `ask:close|${id}`);
    expect(ask().state).toBe("delivered");
    expect(h.slack.ephemerals).toEqual([
      expect.objectContaining({ channel: CHANNEL, user: USERS.bob, text: "Only the person who asked can do that." }),
    ]);
    expect(h.events(id).map((e) => e.kind)).toEqual(["done"]);
  });

  it("reject -> put back loops and the thread message shows the round", async () => {
    const t = await tagAndConfirm(h);
    const id = ask().id as string;

    await h.click(USERS.bob, dmRef(USERS.bob), "ask:reject", id);
    await h.submit(USERS.bob, { reason: "Not my area" });
    expect(ask()).toMatchObject({ state: "rejected", holder_id: USERS.dana });
    const rej = h.slack.im(USERS.dana).messages.at(-1)!;
    expect(text(rej)).toContain("rejected");
    expect(text(rej)).toContain("Not my area");
    expect(liveText(t)).toContain("rejected — waiting on <@UDANA>");

    await h.click(USERS.dana, { channel: h.slack.im(USERS.dana).id, ts: rej.ts }, "ask:put_back", id);
    expect(h.slack.lastModal().callback_id).toBe("modal:put_back");
    expect((await h.submit(USERS.dana, { note: "It is yours: finance is in your area now" })).body).toBeNull();
    expect(ask()).toMatchObject({ state: "proposed", holder_id: USERS.bob, round_count: 1 });
    expect(liveText(t)).toContain("round 2");
    expect(text(h.slack.im(USERS.bob).messages.at(-1)!)).toContain("finance is in your area now");

    // Second round.
    await h.click(USERS.bob, dmRef(USERS.bob), "ask:reject", id);
    await h.submit(USERS.bob, {});
    const rej2 = h.slack.im(USERS.dana).messages.at(-1)!;
    expect(text(rej2)).toContain("No reason given");
    await h.click(USERS.dana, { channel: h.slack.im(USERS.dana).id, ts: rej2.ts }, "ask:put_back", id);
    await h.submit(USERS.dana, { note: "Please" });
    expect(ask().round_count).toBe(2);
    expect(liveText(t)).toContain("round 3");
    expect(h.errors).toEqual([]);
  });

  it("an empty put_back note is refused in the modal", async () => {
    await tagAndConfirm(h);
    const id = ask().id as string;
    await h.click(USERS.bob, dmRef(USERS.bob), "ask:reject", id);
    await h.submit(USERS.bob, {});
    await h.click(USERS.dana, dmRef(USERS.dana), "ask:put_back", id);
    expect(() => h.ingress.viewSubmission(USERS.dana, h.slack.lastModal(), {})).toThrow(/required input "note"/);
  });

  it("the requester withdraws from the live message; the owner is told", async () => {
    const t = await tagAndConfirm(h);
    const id = ask().id as string;
    await h.choose(USERS.dana, card(t), "ask:overflow", `ask:withdraw|${id}`);
    expect(h.slack.lastModal().callback_id).toBe("modal:withdraw");
    await h.submit(USERS.dana, { note: "no longer needed" });
    expect(ask()).toMatchObject({ state: "withdrawn" });
    expect(text(h.slack.im(USERS.bob).messages.at(-1)!)).toContain("withdrew");
    expect(liveText(t)).toContain("withdrawn");
  });

  it("the owner cannot withdraw", async () => {
    const t = await tagAndConfirm(h);
    const id = ask().id as string;
    await h.choose(USERS.bob, card(t), "ask:overflow", `ask:withdraw|${id}`);
    // The modal opens (Slack-side) only if the action is available to the clicker.
    expect(h.slack.callsTo("views.open")).toHaveLength(0);
    expect(h.slack.ephemerals.at(-1)?.user).toBe(USERS.bob);
    expect(ask().state).toBe("proposed");
  });

  it("send back asks the requester; their put back answers", async () => {
    await tagAndConfirm(h);
    const id = ask().id as string;
    await h.choose(USERS.bob, dmRef(USERS.bob), "ask:overflow", `ask:send_back|${id}`);
    await h.submit(USERS.bob, { question: "Which quarter?" });
    expect(ask().state).toBe("clarify");
    const dm = h.slack.im(USERS.dana).messages.at(-1)!;
    expect(text(dm)).toContain("Which quarter?");
    await h.click(USERS.dana, { channel: h.slack.im(USERS.dana).id, ts: dm.ts }, "ask:put_back", id);
    await h.submit(USERS.dana, { note: "Q3" });
    expect(ask().state).toBe("proposed");
  });

  it("a stale click on an ended ask is told so, privately", async () => {
    const t = await tagAndConfirm(h);
    const id = ask().id as string;
    const ref = dmRef(USERS.bob);
    await h.choose(USERS.dana, card(t), "ask:overflow", `ask:withdraw|${id}`);
    await h.submit(USERS.dana, {});
    await h.click(USERS.bob, ref, "ask:accept_now", id);
    expect(ask().state).toBe("withdrawn");
    expect(h.slack.ephemerals.at(-1)).toMatchObject({ user: USERS.bob, text: "This ask is already finished." });
  });
});

describe("modal lifecycle details", () => {
  it("views.open must be called within 3 seconds of the click", async () => {
    await tagAndConfirm(h);
    const payload = h.ingress.blockActions({
      user: USERS.bob, blocks: h.slack.message(dmRef(USERS.bob).channel, dmRef(USERS.bob).ts).blocks ?? [],
      actionId: "ask:accept_later", value: ask().id as string, where: dmRef(USERS.bob),
    });
    h.clock.advance(4000);
    await h.ingress.interaction(payload);
    expect(h.slack.callsTo("views.open")[0]!.error).toBe("expired_trigger_id");
    expect(h.slack.openViews).toHaveLength(0);
  });
});
