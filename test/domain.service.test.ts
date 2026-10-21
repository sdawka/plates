import { beforeEach, describe, expect, it } from "vitest";
import {
  applyAction,
  confirmDiscarded,
  confirmRequest,
  discardRequest,
  dismissRequest,
} from "../src/domain/service";
import {
  getAsk,
  getAsksByRequest,
  getRequest,
  insertAskStmt,
  insertRequest,
  listEvents,
  saveAskStmt,
} from "../src/domain/repo";
import { TransitionError, type AskRow, type DraftAsk, type Effect, type Env, type RequestRow } from "../src/types";
import { asD1, makeDb, type FakeD1 } from "./helpers/fakeD1";

const REQ = "U_REQ";
const OWN = "U_OWN";
const TAG = "U_TAG";
const STR = "U_STR";

let fake: FakeD1;
let env: Env;
const db = () => asD1(fake);

beforeEach(() => {
  fake = makeDb();
  env = { DB: db() } as unknown as Env;
});

const draft = (title: string, over: Partial<DraftAsk> = {}): DraftAsk => ({
  title,
  detail: `${title} detail`,
  type: "deliverable",
  size: "hours",
  urgency: "normal",
  estimate_reason: "because",
  inferred_due_at: null,
  owner_already_committed: false,
  source_ts: "1.1",
  source_permalink: null,
  ...over,
});

function mkRequest(over: Partial<RequestRow> = {}): RequestRow {
  return {
    id: "r1",
    channel_id: "C1",
    thread_ts: "100.1",
    message_ts: "100.2",
    status: "pending_confirmation",
    tagged_by_id: TAG,
    tag_message_ts: null,
    requester_id: REQ,
    owner_id: OWN,
    attribution_confidence: 0.9,
    attribution_reason: null,
    clarify_question: null,
    draft_json: JSON.stringify([draft("first"), draft("second", { type: "acknowledge", size: "2-5min" }), draft("third", { urgency: "high" })]),
    confirmed_by: null,
    confirmed_via: null,
    nudged_at: null,
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

function mkAsk(over: Partial<AskRow> = {}): AskRow {
  return {
    id: "a1",
    request_id: "r1",
    requester_id: REQ,
    owner_id: OWN,
    holder_id: OWN,
    title: "t",
    detail: null,
    type: "deliverable",
    state: "proposed",
    snoozed_from: null,
    size: "hours",
    size_source: "llm",
    urgency: "normal",
    urgency_source: "llm",
    estimate_reason: null,
    inferred_due_at: null,
    deadline_at: null,
    deadline_change_count: 0,
    snoozed_until: null,
    snooze_count: 0,
    round_count: 0,
    source_ts: null,
    source_permalink: null,
    next_step: null,
    done_link: null,
    last_note: null,
    created_at: 10,
    accepted_at: null,
    closed_at: null,
    reminder_stage: 0, last_reminded_at: null, last_bumped_at: null, tracker_ref: null, tracker_url: null,
    updated_at: 10,
    ...over,
  };
}

async function seedAsk(over: Partial<AskRow> = {}, reqOver: Partial<RequestRow> = {}) {
  await insertRequest(db(), mkRequest({ status: "confirmed", ...reqOver }));
  const ask = mkAsk(over);
  await fake.batch([insertAskStmt(db(), ask) as never]);
  return ask;
}

const kinds = (e: Effect[]) => e.map((x) => x.kind);
const homeUsers = (e: Effect[]) => e.filter((x) => x.kind === "refresh_home").map((x) => (x as { userId: string }).userId).sort();
const reschedUsers = (e: Effect[]) => e.filter((x) => x.kind === "reschedule").map((x) => (x as { userId: string }).userId).sort();

async function expectDenied(p: Promise<unknown>, msg?: string | RegExp) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(TransitionError);
    if (msg) expect((e as TransitionError).userMessage).toMatch(msg);
    return;
  }
  expect.unreachable("expected TransitionError");
}

describe("confirmRequest", () => {
  beforeEach(async () => {
    await insertRequest(db(), mkRequest());
  });

  for (const [who, id] of [["requester", REQ], ["owner", OWN]] as const) {
    it(`${who} can confirm`, async () => {
      await confirmRequest(env, "r1", id, "reaction");
      const r = await getRequest(db(), "r1");
      expect(r?.status).toBe("confirmed");
      expect(r?.confirmed_by).toBe(id);
      expect(r?.confirmed_via).toBe("reaction");
    });
  }

  it("tagger is denied with a message naming requester and owner", async () => {
    await expectDenied(confirmRequest(env, "r1", TAG, "reaction"), `<@${REQ}> or <@${OWN}>`);
    expect((await getRequest(db(), "r1"))?.status).toBe("pending_confirmation");
    expect(await getAsksByRequest(db(), "r1")).toHaveLength(0);
  });
  it("stranger is denied", async () => {
    await expectDenied(confirmRequest(env, "r1", STR, "button"), /Needs a ✅ from/);
  });
  it("tagger who is also the requester can confirm", async () => {
    await fake.sqlite.exec("DELETE FROM requests");
    await insertRequest(db(), mkRequest({ tagged_by_id: REQ }));
    await expect(confirmRequest(env, "r1", REQ, "button")).resolves.toBeDefined();
  });

  it("creates asks in draft order with holder=owner, state proposed, drafted fields copied", async () => {
    await confirmRequest(env, "r1", REQ, "reaction");
    const asks = await getAsksByRequest(db(), "r1");
    expect(asks.map((a) => a.title)).toEqual(["first", "second", "third"]);
    for (const a of asks) {
      expect(a.state).toBe("proposed");
      expect(a.holder_id).toBe(OWN);
      expect(a.owner_id).toBe(OWN);
      expect(a.requester_id).toBe(REQ);
      expect(a.round_count).toBe(0);
      expect(a.snooze_count).toBe(0);
      expect(a.deadline_change_count).toBe(0);
      expect(a.size_source).toBe("llm");
      expect(a.request_id).toBe("r1");
    }
    expect(asks[1]).toMatchObject({ type: "acknowledge", size: "2-5min", detail: "second detail" });
    expect(asks[2]?.urgency).toBe("high");
    expect(new Set(asks.map((a) => a.id)).size).toBe(3);
    expect(asks[0]!.created_at).toBeLessThan(asks[1]!.created_at);
  });

  it("returns render_request, request_proposed DM to owner, deduped refresh_home+reschedule", async () => {
    const eff = await confirmRequest(env, "r1", OWN, "reaction");
    expect(eff[0]).toEqual({ kind: "render_request", requestId: "r1" });
    expect(eff).toContainEqual({ kind: "dm", userId: OWN, template: "request_proposed", requestId: "r1" });
    expect(eff.filter((e) => e.kind === "dm")).toHaveLength(1);
    expect(homeUsers(eff)).toEqual([OWN, REQ, TAG].sort());
    expect(reschedUsers(eff)).toEqual([OWN, REQ, TAG].sort());
    expect(eff).toHaveLength(1 + 1 + 6);
  });

  it("dedupes when tagger is the requester", async () => {
    await fake.sqlite.exec("DELETE FROM requests");
    await insertRequest(db(), mkRequest({ tagged_by_id: REQ }));
    const eff = await confirmRequest(env, "r1", REQ, "button");
    expect(homeUsers(eff)).toEqual([OWN, REQ].sort());
    expect(reschedUsers(eff)).toEqual([OWN, REQ].sort());
  });

  it("writes one request-level confirm event", async () => {
    await confirmRequest(env, "r1", REQ, "reaction");
    const ev = fake.all("SELECT * FROM ask_events WHERE request_id = 'r1'");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: "confirm", ask_id: null, actor_id: REQ, via: "reaction", from_state: null, to_state: null });
  });

  it("rejects an already confirmed request and doesn't duplicate asks", async () => {
    await confirmRequest(env, "r1", REQ, "reaction");
    await expectDenied(confirmRequest(env, "r1", REQ, "reaction"), /already confirmed/);
    expect(await getAsksByRequest(db(), "r1")).toHaveLength(3);
  });

  it("rejects missing request and unresolved attribution", async () => {
    await expectDenied(confirmRequest(env, "nope", REQ, "button"), /no longer exists/);
    await insertRequest(db(), mkRequest({ id: "r2", requester_id: null }));
    await expectDenied(confirmRequest(env, "r2", REQ, "button"), /who is asking whom/);
    await insertRequest(db(), mkRequest({ id: "r3", owner_id: null }));
    await expectDenied(confirmRequest(env, "r3", REQ, "button"), /who is asking whom/);
  });

  it("a discarded request must go through confirmDiscarded, not confirmRequest", async () => {
    await discardRequest(env, "r1");
    await expectDenied(confirmRequest(env, "r1", OWN, "home"), /already confirmed/);
    expect((await getRequest(db(), "r1"))?.status).toBe("discarded");
    expect(await getAsksByRequest(db(), "r1")).toHaveLength(0);
  });

  it("handles a request with zero drafts (confirms, creates no asks)", async () => {
    await insertRequest(db(), mkRequest({ id: "r9", draft_json: "[]" }));
    await confirmRequest(env, "r9", REQ, "button");
    expect(await getAsksByRequest(db(), "r9")).toHaveLength(0);
  });

  // BUG: UPDATE ... WHERE status != 'confirmed' result is never checked, so two concurrent
  // confirms (requester and owner both react) both insert the full ask set.
  it("concurrent confirms create the asks only once", async () => {
    const results = await Promise.allSettled([
      confirmRequest(env, "r1", REQ, "reaction"),
      confirmRequest(env, "r1", OWN, "reaction"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await getAsksByRequest(db(), "r1")).toHaveLength(3);
  });
});

describe("discardRequest / confirmDiscarded", () => {
  beforeEach(async () => {
    await insertRequest(db(), mkRequest());
  });

  it("discards a pending request and fans out to requester, owner, tagger", async () => {
    const eff = await discardRequest(env, "r1");
    expect((await getRequest(db(), "r1"))?.status).toBe("discarded");
    expect(eff[0]).toEqual({ kind: "render_request", requestId: "r1" });
    expect(homeUsers(eff)).toEqual([OWN, REQ, TAG].sort());
    expect(kinds(eff).filter((k) => k === "dm")).toHaveLength(0);
  });
  it("discard only works from pending: confirmed, discarded and missing are no-ops", async () => {
    await confirmRequest(env, "r1", REQ, "button");
    expect(await discardRequest(env, "r1")).toEqual([]);
    expect((await getRequest(db(), "r1"))?.status).toBe("confirmed");
    await insertRequest(db(), mkRequest({ id: "r2", status: "discarded" }));
    expect(await discardRequest(env, "r2")).toEqual([]);
    expect(await discardRequest(env, "missing")).toEqual([]);
  });
  it("discard does not create asks", async () => {
    await discardRequest(env, "r1");
    expect(await getAsksByRequest(db(), "r1")).toHaveLength(0);
  });

  it("confirmDiscarded: owner or requester revives and confirms", async () => {
    await discardRequest(env, "r1");
    const eff = await confirmDiscarded(env, "r1", OWN, "home");
    const r = await getRequest(db(), "r1");
    expect(r?.status).toBe("confirmed");
    expect(r?.confirmed_by).toBe(OWN);
    expect(r?.confirmed_via).toBe("home");
    expect(await getAsksByRequest(db(), "r1")).toHaveLength(3);
    expect(eff).toContainEqual({ kind: "dm", userId: OWN, template: "request_proposed", requestId: "r1" });
  });
  it("confirmDiscarded also works on a still-pending request", async () => {
    await confirmDiscarded(env, "r1", REQ, "home");
    expect((await getRequest(db(), "r1"))?.status).toBe("confirmed");
  });
  it("confirmDiscarded by the tagger is denied", async () => {
    await discardRequest(env, "r1");
    await expectDenied(confirmDiscarded(env, "r1", TAG, "home"), /Needs a ✅/);
    expect(await getAsksByRequest(db(), "r1")).toHaveLength(0);
  });
  // BUG: confirmDiscarded flips discarded -> pending BEFORE checking who the user is,
  // so a denied attempt leaves the request "pending_confirmation" instead of "discarded".
  it("a denied confirmDiscarded leaves the request discarded", async () => {
    await discardRequest(env, "r1");
    await expect(confirmDiscarded(env, "r1", STR, "home")).rejects.toBeInstanceOf(TransitionError);
    expect((await getRequest(db(), "r1"))?.status).toBe("discarded");
  });
  it("confirmDiscarded on a missing request is denied", async () => {
    await expectDenied(confirmDiscarded(env, "nope", REQ, "home"), /no longer exists/);
  });
});

describe("applyAction", () => {
  it("persists the new state and returns effects (render, DM, deduped fan-out)", async () => {
    await seedAsk({ state: "in_progress" });
    const eff = await applyAction(env, "a1", { kind: "done", note: "here", link: "http://x" }, OWN, "button");
    const a = await getAsk(db(), "a1");
    expect(a).toMatchObject({ state: "delivered", holder_id: REQ, done_link: "http://x", last_note: "here" });
    expect(eff[0]).toEqual({ kind: "render_request", requestId: "r1" });
    expect(eff[1]).toEqual({ kind: "dm", userId: REQ, template: "ask_delivered", requestId: "r1", askId: "a1", note: "here" });
    expect(homeUsers(eff)).toEqual([OWN, REQ].sort());
    expect(reschedUsers(eff)).toEqual([OWN, REQ].sort());
  });

  it("no DM effect for transitions without a DM (snooze)", async () => {
    await seedAsk({ state: "accepted" });
    const eff = await applyAction(env, "a1", { kind: "snooze", until: Date.now() + 100000 }, OWN, "home");
    expect(kinds(eff)).not.toContain("dm");
    expect((await getAsk(db(), "a1"))?.state).toBe("snoozed");
  });

  it("redirect fans out to the new owner too and DMs them", async () => {
    await seedAsk({ state: "proposed" });
    const eff = await applyAction(env, "a1", { kind: "redirect", toUserId: "U_NEW", note: "yours" }, OWN, "button");
    expect(homeUsers(eff)).toEqual([OWN, REQ, "U_NEW"].sort());
    expect(eff).toContainEqual({ kind: "dm", userId: "U_NEW", template: "ask_proposed", requestId: "r1", askId: "a1", note: "yours" });
    expect(await getAsk(db(), "a1")).toMatchObject({ owner_id: "U_NEW", holder_id: "U_NEW" });
  });

  it("system wake does not fan out to 'system'", async () => {
    await seedAsk({ state: "snoozed", snoozed_from: "accepted", snoozed_until: 5 });
    const eff = await applyAction(env, "a1", { kind: "wake" }, "system", "system");
    expect(homeUsers(eff)).toEqual([OWN, REQ].sort());
    expect((await getAsk(db(), "a1"))?.state).toBe("accepted");
    const ev = await listEvents(db(), "a1");
    expect(ev[0]).toMatchObject({ actor_id: "system", via: "system", kind: "wake", from_state: "snoozed", to_state: "accepted" });
  });

  it("missing ask -> TransitionError", async () => {
    await expectDenied(applyAction(env, "zzz", { kind: "accept_now" }, OWN, "button"), /no longer exists/);
  });

  it("denied transitions throw and write nothing", async () => {
    const before = await seedAsk({ state: "proposed" });
    await expectDenied(applyAction(env, "a1", { kind: "close" }, OWN, "button"), /Only the person who asked/);
    await expectDenied(applyAction(env, "a1", { kind: "accept_now" }, STR, "button"));
    expect(await getAsk(db(), "a1")).toEqual(before);
    expect(await listEvents(db(), "a1")).toHaveLength(0);
  });

  describe("events", () => {
    it("records from/to states, via, actor, note, source_ts", async () => {
      await seedAsk({ state: "proposed" });
      await applyAction(env, "a1", { kind: "reject", reason: " not mine " }, OWN, "thread_reply", "555.1");
      const ev = await listEvents(db(), "a1");
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({
        ask_id: "a1", request_id: "r1", actor_id: OWN, kind: "reject",
        from_state: "proposed", to_state: "rejected", note: "not mine", via: "thread_reply", source_ts: "555.1",
      });
    });
    it("source_ts defaults to null; note null when none", async () => {
      await seedAsk({ state: "delivered", holder_id: REQ });
      await applyAction(env, "a1", { kind: "close" }, REQ, "home");
      const [e] = await listEvents(db(), "a1");
      expect(e).toMatchObject({ source_ts: null, note: null, via: "home", from_state: "delivered", to_state: "closed" });
    });
    it("full back-and-forth is logged in order", async () => {
      await seedAsk({ state: "proposed" });
      const steps: [Parameters<typeof applyAction>[2], string, string, string][] = [
        [{ kind: "accept_now" }, OWN, "button", "in_progress"],
        [{ kind: "send_back", question: "which?" }, OWN, "dm", "clarify"],
        [{ kind: "put_back", note: "this one" }, REQ, "button", "proposed"],
        [{ kind: "reject", reason: "no" }, OWN, "reaction", "rejected"],
        [{ kind: "put_back", note: "yes you" }, REQ, "home", "proposed"],
        [{ kind: "done" }, OWN, "command", "delivered"],
        [{ kind: "close" }, REQ, "button", "closed"],
      ];
      for (const [a, who, via] of steps) await applyAction(env, "a1", a, who, via as never);
      const ev = await listEvents(db(), "a1");
      expect(ev.map((e) => e.to_state)).toEqual(steps.map((s) => s[3]));
      expect(ev.map((e) => e.from_state)).toEqual([null, ...steps.map((s) => s[3])].slice(0, steps.length).map((x, i) => (i === 0 ? "proposed" : x)));
      expect(ev.map((e) => e.via)).toEqual(steps.map((s) => s[2]));
      const final = await getAsk(db(), "a1");
      expect(final).toMatchObject({ state: "closed", round_count: 2 });
      expect(final?.closed_at).not.toBeNull();
    });
    it("event timestamps strictly increase even when actions land in the same millisecond", async () => {
      await seedAsk({ state: "proposed", updated_at: Date.now() + 10_000 });
      await applyAction(env, "a1", { kind: "accept_now" }, OWN, "button");
      await applyAction(env, "a1", { kind: "set_estimate", size: "days" }, OWN, "button");
      const ev = await listEvents(db(), "a1");
      expect(ev[1]!.at).toBeGreaterThan(ev[0]!.at);
    });
  });

  describe("optimistic concurrency", () => {
    it("saveAskStmt with a stale updated_at changes 0 rows and leaves the row untouched", async () => {
      const ask = await seedAsk({ state: "proposed" });
      const [r] = await fake.batch([saveAskStmt(db(), { ...ask, state: "in_progress", updated_at: 11 }, 999) as never]);
      expect(r!.meta.changes).toBe(0);
      expect((await getAsk(db(), "a1"))?.state).toBe("proposed");
    });
    it("saveAskStmt with the right updated_at changes exactly 1 row", async () => {
      const ask = await seedAsk({ state: "proposed" });
      const [r] = await fake.batch([saveAskStmt(db(), { ...ask, state: "in_progress", updated_at: 11 }, 10) as never]);
      expect(r!.meta.changes).toBe(1);
    });

    /** DB whose first asks SELECT is followed by a competing writer bumping updated_at. */
    function racyEnv(): Env {
      let raced = false;
      const real = fake;
      const wrapped = {
        prepare(sql: string) {
          const st = real.prepare(sql);
          if (!raced && /FROM asks WHERE id/i.test(sql)) {
            return {
              bind: (...p: unknown[]) => {
                const b = st.bind(...p);
                return {
                  ...b,
                  first: async (c?: string) => {
                    const row = await b.first(c);
                    raced = true;
                    real.sqlite.prepare("UPDATE asks SET state = 'in_progress', updated_at = updated_at + 5 WHERE id = 'a1'").run();
                    return row;
                  },
                };
              },
            };
          }
          return st;
        },
        batch: (s: never[]) => real.batch(s),
      };
      return { DB: wrapped as unknown as D1Database } as unknown as Env;
    }

    it("applyAction throws TransitionError when the ask changed between read and write", async () => {
      await seedAsk({ state: "proposed" });
      await expectDenied(applyAction(racyEnv(), "a1", { kind: "reject", reason: "x" }, OWN, "button"), /Someone just changed/);
      // the competing writer's state wins
      expect((await getAsk(db(), "a1"))?.state).toBe("in_progress");
    });

    // BUG: insertEventStmt is in the same batch as the failed save, so the conflicting action's
    // event is committed even though the state change was not (comment in service.ts calls it "harmless",
    // but the log now claims a reject happened).
    it("a conflicting action leaves no event in the log", async () => {
      await seedAsk({ state: "proposed" });
      await expect(applyAction(racyEnv(), "a1", { kind: "reject", reason: "x" }, OWN, "button")).rejects.toBeInstanceOf(TransitionError);
      expect(await listEvents(db(), "a1")).toHaveLength(0);
    });

    it("two concurrent applyActions: at most one wins per version, state stays consistent", async () => {
      await seedAsk({ state: "proposed", updated_at: Date.now() - 1000 });
      const res = await Promise.allSettled([
        applyAction(env, "a1", { kind: "accept_now" }, OWN, "button"),
        applyAction(env, "a1", { kind: "reject", reason: "no" }, OWN, "button"),
      ]);
      expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rej = res.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(rej.reason).toBeInstanceOf(TransitionError);
    });
  });
});

describe("dismissRequest", () => {
  beforeEach(async () => {
    await insertRequest(db(), mkRequest());
  });

  it("requester, owner or tagger dismisses a pending request; it fans out and logs an event", async () => {
    const eff = await dismissRequest(env, "r1", TAG, "home");
    expect((await getRequest(db(), "r1"))?.status).toBe("dismissed");
    expect(eff[0]).toEqual({ kind: "render_request", requestId: "r1" });
    expect(homeUsers(eff)).toEqual([OWN, REQ, TAG].sort());
    expect(await getAsksByRequest(db(), "r1")).toHaveLength(0);
    expect(fake.all("SELECT * FROM ask_events WHERE request_id = 'r1'")[0]).toMatchObject({ kind: "dismiss", actor_id: TAG, via: "home" });
  });
  it("dismisses a discarded request", async () => {
    await discardRequest(env, "r1");
    await dismissRequest(env, "r1", OWN, "home");
    expect((await getRequest(db(), "r1"))?.status).toBe("dismissed");
  });
  it("a stranger cannot dismiss", async () => {
    await expectDenied(dismissRequest(env, "r1", STR, "home"), /people involved/);
    expect((await getRequest(db(), "r1"))?.status).toBe("pending_confirmation");
  });
  it("confirmed, dismissed and missing requests are denied", async () => {
    await insertRequest(db(), mkRequest({ id: "r2" }));
    await confirmRequest(env, "r2", REQ, "button");
    await expectDenied(dismissRequest(env, "r2", REQ, "home"), /already confirmed/);
    await dismissRequest(env, "r1", REQ, "home");
    await expectDenied(dismissRequest(env, "r1", REQ, "home"), /already dismissed/);
    await expectDenied(dismissRequest(env, "nope", REQ, "home"), /no longer exists/);
  });
  it("a dismissed request can't be confirmed", async () => {
    await dismissRequest(env, "r1", REQ, "home");
    await expectDenied(confirmDiscarded(env, "r1", REQ, "home"), /dismissed/);
    expect(await getAsksByRequest(db(), "r1")).toHaveLength(0);
  });
});
