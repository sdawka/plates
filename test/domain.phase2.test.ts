import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUMP_INTERVAL_MS, UNDO_WINDOW_MS, applyAction, bumpAsk, undoEvent } from "../src/domain/service";
import { getAsk, listEvents } from "../src/domain/repo";
import { TransitionError, type AskRow, type Effect, type Env } from "../src/types";
import { MONDAY_10AM } from "./helpers/env";
import { asD1, makeDb, type FakeD1 } from "./helpers/fakeD1";
import { seedRequest } from "./helpers/seed";


const REQ = "UDANA";
const OWN = "UBOB";
const OTHER = "UEVE";
const MIN = 60_000;

let fake: FakeD1;
let env: Env;
let askId: string;
let reqId: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(MONDAY_10AM);
  fake = makeDb();
  env = { DB: asD1(fake) } as unknown as Env;
  const seeded = await seedRequest({ env }, { id: "r1" }, [{ id: "a1", title: "Report", type: "deliverable" }]);
  askId = seeded.asks[0]!.id;
  reqId = seeded.req.id;
});

const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
const ask = async () => (await getAsk(env.DB, askId))!;
const events = () => listEvents(env.DB, askId);
const dms = (effects: Effect[]) => effects.filter((e): e is Extract<Effect, { kind: "dm" }> => e.kind === "dm");
const denied = async (p: Promise<unknown>, userMessage: RegExp | string) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(TransitionError);
  expect((err as TransitionError).userMessage).toMatch(userMessage);
};

/** Owner marks it done, returning the id of that event. */
async function doneByOwner(): Promise<string> {
  const r = await (await import("../src/domain/service")).applyActionDetailed(env, askId, { kind: "done", note: "ok" }, OWN, "button");
  return r.eventId;
}

describe("undoEvent", () => {
  it("restores the snapshot, writes an undo event and tells whoever lost the ask", async () => {
    const before = await ask();
    const eventId = await doneByOwner();
    expect((await ask()).state).toBe("delivered");

    advance(2 * MIN);
    const effects = await undoEvent(env, eventId, OWN, "button");

    const after = await ask();
    expect(after).toMatchObject({ state: "proposed", holder_id: OWN, last_note: null, done_link: null });
    expect({ ...after, updated_at: 0 }).toEqual({ ...before, updated_at: 0 });
    expect(after.updated_at).toBeGreaterThan(before.updated_at);

    const evs = await events();
    expect(evs.map((e) => e.kind)).toEqual(["done", "undo"]);
    expect(evs[1]).toMatchObject({ actor_id: OWN, from_state: "delivered", to_state: "proposed", note: "done", prev_json: null, via: "button" });

    // The requester held it when it was undone, so the requester is told.
    expect(dms(effects)).toEqual([expect.objectContaining({ userId: REQ, template: "action_undone", askId, note: "done" })]);
    expect(effects).toEqual(expect.arrayContaining([
      { kind: "render_request", requestId: reqId },
      { kind: "refresh_home", userId: REQ },
      { kind: "refresh_home", userId: OWN },
      { kind: "tracker_sync", askId },
    ]));
  });

  it("only the actor may undo", async () => {
    const eventId = await doneByOwner();
    await denied(undoEvent(env, eventId, REQ, "button"), "Only the person who did this can undo it.");
    await denied(undoEvent(env, eventId, OTHER, "button"), "Only the person who did this can undo it.");
    expect((await ask()).state).toBe("delivered");
  });

  it("works up to 15 minutes and not after", async () => {
    const eventId = await doneByOwner();
    advance(UNDO_WINDOW_MS + 2);
    await denied(undoEvent(env, eventId, OWN, "button"), /too late/);
    expect((await ask()).state).toBe("delivered");

    const fresh = await seedRequest({ env }, { id: "r2" }, [{ id: "a2" }]);
    const r = await (await import("../src/domain/service")).applyActionDetailed(env, fresh.asks[0]!.id, { kind: "accept_now" }, OWN, "button");
    advance(UNDO_WINDOW_MS);
    await expect(undoEvent(env, r.eventId, OWN, "button")).resolves.toBeTruthy();
  });

  it("is refused once anything changed the ask later", async () => {
    const e1 = await doneByOwner();
    advance(MIN);
    await applyAction(env, askId, { kind: "close" }, REQ, "button");
    advance(MIN);
    await denied(undoEvent(env, e1, OWN, "button"), /changed since/);
    expect((await ask()).state).toBe("closed");
  });

  it("cannot undo an undo, nor an unknown or confirm event", async () => {
    const eventId = await doneByOwner();
    await undoEvent(env, eventId, OWN, "button");
    const undoRow = (await events()).find((e) => e.kind === "undo")!;
    await denied(undoEvent(env, undoRow.id, OWN, "button"), "That can't be undone.");
    await denied(undoEvent(env, "nope", OWN, "button"), "That can't be undone.");
    // The same event cannot be undone twice either.
    await denied(undoEvent(env, eventId, OWN, "button"), /changed since/);
  });

  it("restores redirects: the new holder is told, the old owner gets the ask back", async () => {
    const r = await (await import("../src/domain/service")).applyActionDetailed(env, askId, { kind: "redirect", toUserId: OTHER }, OWN, "button");
    expect((await ask())).toMatchObject({ owner_id: OTHER, holder_id: OTHER });
    advance(MIN);
    const effects = await undoEvent(env, r.eventId, OWN, "button");
    expect(await ask()).toMatchObject({ owner_id: OWN, holder_id: OWN, state: "proposed" });
    expect(dms(effects).map((d) => d.userId)).toEqual([OTHER]);
    expect(effects).toEqual(expect.arrayContaining([{ kind: "refresh_home", userId: OTHER }]));
  });

  it("two simultaneous undos: exactly one wins", async () => {
    const eventId = await doneByOwner();
    const results = await Promise.allSettled([undoEvent(env, eventId, OWN, "button"), undoEvent(env, eventId, OWN, "button")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(TransitionError);
    expect((await events()).filter((e) => e.kind === "undo")).toHaveLength(1);
  });

  it("after an undo the action can be redone", async () => {
    const eventId = await doneByOwner();
    advance(MIN);
    await undoEvent(env, eventId, OWN, "button");
    advance(MIN);
    await applyAction(env, askId, { kind: "accept_now" }, OWN, "button");
    expect((await ask()).state).toBe("in_progress");
  });

  // src bug: undo restores the whole pre-action snapshot, so fields written after the action by other
  // flows (here a bump, which does not touch updated_at) are rolled back and the requester may bump again.
  // Fix: restore only the fields the action changed, or refuse undo / re-apply bookkeeping columns.
  it("keeps a bump that happened after the action", async () => {
    const eventId = await doneByOwner(); // moves to the requester plate
    const accept = await seedRequest({ env }, { id: "r3" }, [{ id: "a3" }]);
    const e = await (await import("../src/domain/service")).applyActionDetailed(env, accept.asks[0]!.id, { kind: "accept_now" }, OWN, "button");
    advance(MIN);
    await bumpAsk(env, accept.asks[0]!.id, REQ, "button");
    const bumpedAt = (await getAsk(env.DB, accept.asks[0]!.id))!.last_bumped_at;
    expect(bumpedAt).not.toBeNull();
    await undoEvent(env, e.eventId, OWN, "button");
    expect((await getAsk(env.DB, accept.asks[0]!.id))!.last_bumped_at).toBe(bumpedAt);
    void eventId;
  });
});

describe("bumpAsk", () => {
  it("the requester bumps an ask on the owner's plate; the owner is DMed", async () => {
    const effects = await bumpAsk(env, askId, REQ, "button");
    expect(effects).toEqual([
      { kind: "dm", userId: OWN, template: "bump", requestId: reqId, askId },
      { kind: "refresh_home", userId: REQ },
    ]);
    const a = await ask();
    expect(a.last_bumped_at).toBe(Date.now());
    expect(a.state).toBe("proposed"); // a bump never changes state
    expect((await events()).map((e) => [e.kind, e.actor_id])).toEqual([["bump", REQ]]);
  });

  it.each(["proposed", "in_progress", "accepted", "snoozed"] as const)("is allowed while %s", async (state) => {
    await seedRequest({ env }, { id: `r-${state}` }, [{ id: `a-${state}`, state }]);
    await expect(bumpAsk(env, `a-${state}`, REQ, "button")).resolves.toBeTruthy();
  });

  it.each(["delivered", "rejected", "clarify", "closed", "withdrawn"] as const)("is refused while %s (not on the owner's plate)", async (state) => {
    await seedRequest({ env }, { id: `r-${state}` }, [{ id: `a-${state}`, state, holder_id: state === "closed" || state === "withdrawn" ? OWN : REQ }]);
    await denied(bumpAsk(env, `a-${state}`, REQ, "button"), "This ask isn't waiting on anyone right now.");
  });

  it("only the requester may bump", async () => {
    await denied(bumpAsk(env, askId, OWN, "button"), "Only the person who asked can bump it.");
    await denied(bumpAsk(env, askId, OTHER, "button"), "Only the person who asked can bump it.");
    expect((await ask()).last_bumped_at).toBeNull();
    expect(await events()).toHaveLength(0);
  });

  it("once per 20 hours", async () => {
    await bumpAsk(env, askId, REQ, "button");
    advance(BUMP_INTERVAL_MS - 1);
    await denied(bumpAsk(env, askId, REQ, "button"), "You've already bumped this today.");
    advance(2);
    await expect(bumpAsk(env, askId, REQ, "button")).resolves.toBeTruthy();
    expect((await events()).filter((e) => e.kind === "bump")).toHaveLength(2);
  });

  // src bug (src/domain/service.ts bumpAsk): the JS guard allows a bump at exactly 20h
  // (`now - last < INTERVAL` is false) but the SQL guard `last_bumped_at < now - INTERVAL` is false too,
  // so the boundary bump fails with "bumped concurrently" / "You've already bumped this today".
  // Fix: use `last_bumped_at <= ?` in the UPDATE.
  it("allows a bump exactly 20 hours after the previous one", async () => {
    await bumpAsk(env, askId, REQ, "button");
    advance(BUMP_INTERVAL_MS);
    await expect(bumpAsk(env, askId, REQ, "button")).resolves.toBeTruthy();
  });

  it("concurrent bumps: exactly one succeeds and one DM is produced", async () => {
    const results = await Promise.allSettled([bumpAsk(env, askId, REQ, "button"), bumpAsk(env, askId, REQ, "button"), bumpAsk(env, askId, REQ, "home")]);
    const ok = results.filter((r): r is PromiseFulfilledResult<Effect[]> => r.status === "fulfilled");
    expect(ok).toHaveLength(1);
    expect(dms(ok[0]!.value)).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(TransitionError);
    expect((await events()).filter((e) => e.kind === "bump")).toHaveLength(1);
  });

  it("a bump does not block undoing the previous action", async () => {
    const accept = await applyAction(env, askId, { kind: "accept_now" }, OWN, "button");
    expect(accept.length).toBeGreaterThan(0);
    const ev = (await events())[0]!;
    advance(MIN);
    await bumpAsk(env, askId, REQ, "button");
    await expect(undoEvent(env, ev.id, OWN, "button")).resolves.toBeTruthy();
  });

  it("an unknown ask is reported", async () => {
    await denied(bumpAsk(env, "missing", REQ, "button"), "That ask no longer exists.");
  });
});
