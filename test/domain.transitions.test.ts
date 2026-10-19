import { describe, expect, it } from "vitest";
import { availableActions, transition } from "../src/domain/transitions";
import {
  OWNER_PLATE_STATES,
  REQUESTER_PLATE_STATES,
  TERMINAL_STATES,
  TransitionError,
  type AskAction,
  type AskRow,
  type AskState,
} from "../src/types";

const REQ = "U_REQ";
const OWN = "U_OWN";
const STR = "U_STR";
const NEW = "U_NEW";
const NOW = 1_000_000;
const HOUR = 3_600_000;

const ALL_STATES: AskState[] = [...OWNER_PLATE_STATES, ...REQUESTER_PLATE_STATES, ...TERMINAL_STATES];

function mk(over: Partial<AskRow> = {}): AskRow {
  const state = over.state ?? "proposed";
  const onRequester = REQUESTER_PLATE_STATES.includes(state);
  const requester_id = over.requester_id ?? REQ;
  const owner_id = over.owner_id ?? OWN;
  return {
    id: "ask1",
    request_id: "req1",
    requester_id,
    owner_id,
    holder_id: onRequester ? requester_id : owner_id,
    title: "Q3 numbers",
    detail: null,
    type: "deliverable",
    state,
    snoozed_from: state === "snoozed" ? "accepted" : null,
    size: "hours",
    size_source: "llm",
    urgency: "normal",
    urgency_source: "llm",
    estimate_reason: null,
    inferred_due_at: null,
    deadline_at: null,
    deadline_change_count: 0,
    snoozed_until: state === "snoozed" ? NOW + HOUR : null,
    snooze_count: 0,
    round_count: 0,
    source_ts: null,
    source_permalink: null,
    next_step: null,
    done_link: null,
    last_note: null,
    created_at: 1,
    accepted_at: null,
    closed_at: null,
    reminder_stage: 0, last_reminded_at: null, last_bumped_at: null, tracker_ref: null, tracker_url: null,
    updated_at: 1,
    ...over,
  };
}

const go = (ask: AskRow, action: AskAction, actor: string) => transition(ask, action, actor, NOW);
const denied = (ask: AskRow, action: AskAction, actor: string) =>
  expect(() => go(ask, action, actor)).toThrow(TransitionError);

describe("plate invariant: holder_id", () => {
  const owner: AskAction[] = [
    { kind: "accept_now" },
    { kind: "accept_later", deadlineAt: NOW + HOUR },
    { kind: "set_estimate", size: "days" },
    { kind: "snooze", until: NOW + HOUR },
  ];
  for (const state of OWNER_PLATE_STATES) {
    for (const a of owner) {
      const ask = mk({ state, deadline_at: NOW + 5 });
      let ok = true;
      try {
        go(ask, a, OWN);
      } catch {
        ok = false;
      }
      if (!ok) continue;
      it(`${state} --${a.kind}--> stays on owner plate`, () => {
        const { next } = go(ask, a, OWN);
        expect(OWNER_PLATE_STATES).toContain(next.state);
        expect(next.holder_id).toBe(OWN);
      });
    }
  }

  const toRequester: [AskAction, AskState][] = [
    [{ kind: "done" }, "delivered"],
    [{ kind: "ack", nextStep: "on it" }, "delivered"],
    [{ kind: "reject" }, "rejected"],
    [{ kind: "send_back", question: "which account?" }, "clarify"],
  ];
  for (const state of OWNER_PLATE_STATES) {
    for (const [a, to] of toRequester) {
      it(`${state} --${a.kind}--> ${to} on requester plate`, () => {
        const { next } = go(mk({ state, deadline_at: 5 }), a, OWN);
        expect(next.state).toBe(to);
        expect(next.holder_id).toBe(REQ);
        expect(next.snoozed_from).toBeNull();
        expect(next.snoozed_until).toBeNull();
      });
    }
  }

  it("put_back and redirect land on an owner plate", () => {
    for (const state of REQUESTER_PLATE_STATES) {
      const pb = go(mk({ state }), { kind: "put_back", note: "n" }, REQ).next;
      expect(pb.holder_id).toBe(OWN);
      expect(pb.state).toBe("proposed");
      const rd = go(mk({ state }), { kind: "redirect", toUserId: NEW }, REQ).next;
      expect(rd.holder_id).toBe(NEW);
      expect(rd.owner_id).toBe(NEW);
    }
  });

  it("holder always matches the plate state after any accepted action (exhaustive)", () => {
    const actions = actionsFor(mk());
    for (const state of ALL_STATES) {
      for (const actor of [OWN, REQ, STR, "system"]) {
        for (const a of actions) {
          let r;
          try {
            r = go(mk({ state, deadline_at: 5 }), a, actor);
          } catch {
            continue;
          }
          const n = r.next;
          if (OWNER_PLATE_STATES.includes(n.state)) expect(n.holder_id).toBe(n.owner_id);
          else if (REQUESTER_PLATE_STATES.includes(n.state)) expect(n.holder_id).toBe(n.requester_id);
        }
      }
    }
  });
});

function actionsFor(ask: AskRow): AskAction[] {
  return [
    { kind: "accept_now" },
    { kind: "accept_later", deadlineAt: NOW + HOUR },
    { kind: "done", note: "x", link: "http://l" },
    { kind: "ack", nextStep: "soon" },
    { kind: "reject", reason: "no" },
    { kind: "send_back", question: "q?" },
    { kind: "set_deadline", deadlineAt: (ask.deadline_at ?? 0) + 777 },
    { kind: "snooze", until: NOW + HOUR },
    { kind: "set_estimate", size: "days", urgency: "high" },
    { kind: "redirect", toUserId: NEW },
    { kind: "close" },
    { kind: "put_back", note: "again" },
    { kind: "withdraw" },
    { kind: "wake" },
  ];
}

describe("who can end an ask", () => {
  it("only the requester can close or withdraw", () => {
    for (const state of REQUESTER_PLATE_STATES) {
      expect(go(mk({ state }), { kind: "close" }, REQ).next.state).toBe("closed");
      denied(mk({ state }), { kind: "close" }, OWN);
      denied(mk({ state }), { kind: "close" }, STR);
    }
    for (const state of [...OWNER_PLATE_STATES, ...REQUESTER_PLATE_STATES]) {
      expect(go(mk({ state }), { kind: "withdraw" }, REQ).next.state).toBe("withdrawn");
      denied(mk({ state }), { kind: "withdraw" }, OWN);
      denied(mk({ state }), { kind: "withdraw" }, STR);
    }
  });

  it("the owner can never reach closed or withdrawn, whatever action they try", () => {
    for (const state of ALL_STATES) {
      for (const a of actionsFor(mk())) {
        try {
          const n = go(mk({ state, deadline_at: 5 }), a, OWN).next.state;
          expect(["closed", "withdrawn"]).not.toContain(n);
        } catch (e) {
          expect(e).toBeInstanceOf(TransitionError);
        }
      }
    }
  });

  it("close is only allowed from the requester's plate (not while on the owner's)", () => {
    for (const state of OWNER_PLATE_STATES) denied(mk({ state }), { kind: "close" }, REQ);
  });

  it("close sets closed_at, keeps holder, records note", () => {
    const { next, note, dm, eventKind } = go(mk({ state: "delivered" }), { kind: "close", note: "thanks" }, REQ);
    expect(next.closed_at).toBe(NOW);
    expect(next.holder_id).toBe(REQ);
    expect(note).toBe("thanks");
    expect(dm).toBeNull();
    expect(eventKind).toBe("close");
  });

  it("withdraw DMs the owner only when it was on the owner's plate", () => {
    for (const state of OWNER_PLATE_STATES) {
      expect(go(mk({ state }), { kind: "withdraw" }, REQ).dm).toEqual({ userId: OWN, template: "ask_withdrawn" });
    }
    for (const state of REQUESTER_PLATE_STATES) {
      expect(go(mk({ state }), { kind: "withdraw" }, REQ).dm).toBeNull();
    }
  });

  it("withdraw clears snoozed_until and stamps closed_at", () => {
    const { next } = go(mk({ state: "snoozed" }), { kind: "withdraw", note: "n" }, REQ);
    expect(next.snoozed_until).toBeNull();
    expect(next.closed_at).toBe(NOW);
  });

  it("done/ack moves to delivered on requester plate with DM", () => {
    const d = go(mk({ state: "in_progress" }), { kind: "done", note: "see link", link: "http://x" }, OWN);
    expect(d.next.state).toBe("delivered");
    expect(d.next.done_link).toBe("http://x");
    expect(d.next.last_note).toBe("see link");
    expect(d.dm).toEqual({ userId: REQ, template: "ask_delivered" });
    const a = go(mk({ state: "proposed", type: "acknowledge" }), { kind: "ack", nextStep: "Friday" }, OWN);
    expect(a.next.state).toBe("delivered");
    expect(a.next.next_step).toBe("Friday");
    expect(a.note).toBe("Friday");
  });

  it("done without link clears done_link", () => {
    expect(go(mk({ state: "in_progress", done_link: "old" }), { kind: "done" }, OWN).next.done_link).toBeNull();
  });
});

describe("actor/plate permission checks", () => {
  const ownerKinds: AskAction[] = [
    { kind: "accept_now" },
    { kind: "accept_later", deadlineAt: null },
    { kind: "done" },
    { kind: "ack", nextStep: "s" },
    { kind: "reject" },
    { kind: "send_back", question: "q" },
    { kind: "set_deadline", deadlineAt: NOW + 5 },
    { kind: "snooze", until: NOW + 5 },
    { kind: "set_estimate", size: "lt1h" },
  ];
  it("owner actions are rejected for non-owners (requester, stranger, system)", () => {
    for (const state of OWNER_PLATE_STATES) {
      for (const a of ownerKinds) {
        for (const actor of [REQ, STR, "system"]) denied(mk({ state, deadline_at: 5 }), a, actor);
      }
    }
  });
  it("owner actions are rejected when the ask is on the requester's plate", () => {
    for (const state of REQUESTER_PLATE_STATES) {
      for (const a of ownerKinds) denied(mk({ state, deadline_at: 5 }), a, OWN);
    }
  });
  it("requester actions are rejected for non-requesters", () => {
    const reqKinds: AskAction[] = [{ kind: "close" }, { kind: "put_back", note: "n" }, { kind: "withdraw" }];
    for (const state of REQUESTER_PLATE_STATES) {
      for (const a of reqKinds) for (const actor of [OWN, STR, "system"]) denied(mk({ state }), a, actor);
    }
  });
  it("put_back is not allowed while on the owner's plate", () => {
    for (const state of OWNER_PLATE_STATES) denied(mk({ state }), { kind: "put_back", note: "n" }, REQ);
  });
  it("strangers can do nothing at all", () => {
    for (const state of ALL_STATES) {
      for (const a of actionsFor(mk())) if (a.kind !== "wake") denied(mk({ state, deadline_at: 5 }), a, STR);
    }
  });
  it("user-facing message is present on denials", () => {
    try {
      go(mk(), { kind: "accept_now" }, STR);
      expect.unreachable();
    } catch (e) {
      expect((e as TransitionError).userMessage.length).toBeGreaterThan(0);
    }
  });
});

describe("terminal states", () => {
  for (const state of TERMINAL_STATES) {
    it(`${state} rejects every action by every actor`, () => {
      for (const actor of [OWN, REQ, STR, "system"]) {
        for (const a of actionsFor(mk())) denied(mk({ state }), a, actor);
      }
    });
    it(`${state} has no available actions`, () => {
      for (const v of [OWN, REQ, STR]) expect(availableActions(mk({ state }), v)).toEqual([]);
    });
  }
});

describe("put_back", () => {
  for (const state of REQUESTER_PLATE_STATES) {
    it(`from ${state} -> proposed on owner's plate, round++, DM owner`, () => {
      const r = go(mk({ state, round_count: 2, deadline_at: 99, accepted_at: 5 }), { kind: "put_back", note: "more detail" }, REQ);
      expect(r.next.state).toBe("proposed");
      expect(r.next.holder_id).toBe(OWN);
      expect(r.next.round_count).toBe(3);
      expect(r.next.deadline_at).toBeNull();
      expect(r.next.accepted_at).toBeNull();
      expect(r.next.last_note).toBe("more detail");
      expect(r.note).toBe("more detail");
      expect(r.dm).toEqual({ userId: OWN, template: "ask_proposed" });
    });
  }
  it("has no round limit: 200 loops of reject -> put_back", () => {
    let ask = mk();
    for (let i = 0; i < 200; i++) {
      ask = go(ask, { kind: "reject", reason: "no" }, OWN).next;
      expect(ask.holder_id).toBe(REQ);
      ask = go(ask, { kind: "put_back", note: `r${i}` }, REQ).next;
      expect(ask.state).toBe("proposed");
    }
    expect(ask.round_count).toBe(200);
    expect(go(ask, { kind: "accept_now" }, OWN).next.state).toBe("in_progress");
  });
  it("loops through all three requester-plate states", () => {
    let ask = mk();
    const seq: AskAction[] = [{ kind: "send_back", question: "q" }, { kind: "reject" }, { kind: "done" }];
    for (let i = 0; i < 30; i++) {
      ask = go(ask, seq[i % 3]!, OWN).next;
      ask = go(ask, { kind: "put_back", note: "n" }, REQ).next;
    }
    expect(ask.round_count).toBe(30);
  });
});

describe("redirect", () => {
  it("owner redirects from every owner-plate state; deadline/snooze reset, DM new owner", () => {
    for (const state of OWNER_PLATE_STATES) {
      const r = go(mk({ state, deadline_at: 50, accepted_at: 3 }), { kind: "redirect", toUserId: NEW, note: "carol owns it" }, OWN);
      expect(r.next.owner_id).toBe(NEW);
      expect(r.next.holder_id).toBe(NEW);
      expect(r.next.state).toBe("proposed");
      expect(r.next.deadline_at).toBeNull();
      expect(r.next.accepted_at).toBeNull();
      expect(r.next.snoozed_until).toBeNull();
      expect(r.next.snoozed_from).toBeNull();
      expect(r.next.requester_id).toBe(REQ);
      expect(r.dm).toEqual({ userId: NEW, template: "ask_proposed" });
      expect(r.note).toBe("carol owns it");
    }
  });
  it("requester redirects from proposed and from requester plates", () => {
    for (const state of ["proposed", ...REQUESTER_PLATE_STATES] as AskState[]) {
      const r = go(mk({ state }), { kind: "redirect", toUserId: NEW }, REQ);
      expect(r.next.owner_id).toBe(NEW);
      expect(r.next.holder_id).toBe(NEW);
      expect(r.next.state).toBe("proposed");
      expect(r.dm).toEqual({ userId: NEW, template: "ask_proposed" });
    }
  });
  it("requester cannot redirect while the ask is in progress/accepted/snoozed", () => {
    for (const state of ["in_progress", "accepted", "snoozed"] as AskState[]) {
      denied(mk({ state }), { kind: "redirect", toUserId: NEW }, REQ);
    }
  });
  it("owner cannot redirect from requester plate; stranger never", () => {
    for (const state of REQUESTER_PLATE_STATES) denied(mk({ state }), { kind: "redirect", toUserId: NEW }, OWN);
    for (const state of ALL_STATES) denied(mk({ state }), { kind: "redirect", toUserId: NEW }, STR);
  });
  it("redirecting to the current owner (while on owner plate) is denied", () => {
    denied(mk({ state: "proposed" }), { kind: "redirect", toUserId: OWN }, REQ);
    denied(mk({ state: "in_progress" }), { kind: "redirect", toUserId: OWN }, OWN);
  });
  it("redirect keeps counters (snooze/round/deadline_change)", () => {
    const r = go(mk({ state: "snoozed", snooze_count: 2, round_count: 1, deadline_change_count: 4 }), { kind: "redirect", toUserId: NEW }, OWN);
    expect(r.next.snooze_count).toBe(2);
    expect(r.next.round_count).toBe(1);
    expect(r.next.deadline_change_count).toBe(4);
  });
});

describe("snooze and wake", () => {
  it("increments the count and remembers the prior state", () => {
    const r = go(mk({ state: "in_progress" }), { kind: "snooze", until: NOW + HOUR }, OWN);
    expect(r.next.state).toBe("snoozed");
    expect(r.next.snoozed_from).toBe("in_progress");
    expect(r.next.snoozed_until).toBe(NOW + HOUR);
    expect(r.next.snooze_count).toBe(1);
    expect(r.next.holder_id).toBe(OWN);
    expect(r.dm).toBeNull();
  });
  it("preserves snoozed_from across re-snooze and keeps counting", () => {
    let a = go(mk({ state: "accepted" }), { kind: "snooze", until: NOW + HOUR }, OWN).next;
    a = go(a, { kind: "snooze", until: NOW + 2 * HOUR }, OWN).next;
    a = go(a, { kind: "snooze", until: NOW + 3 * HOUR }, OWN).next;
    expect(a.snoozed_from).toBe("accepted");
    expect(a.snooze_count).toBe(3);
    expect(a.snoozed_until).toBe(NOW + 3 * HOUR);
  });
  it("snoozing from proposed is allowed and wake restores proposed", () => {
    const s = go(mk({ state: "proposed" }), { kind: "snooze", until: NOW + HOUR }, OWN).next;
    expect(s.snoozed_from).toBe("proposed");
    expect(go(s, { kind: "wake" }, "system").next.state).toBe("proposed");
  });
  it("wake restores prior state and clears snooze fields, keeps count", () => {
    for (const from of ["proposed", "in_progress", "accepted"] as AskState[]) {
      const s = go(mk({ state: from }), { kind: "snooze", until: NOW + HOUR }, OWN).next;
      const w = go(s, { kind: "wake" }, "system");
      expect(w.next.state).toBe(from);
      expect(w.next.snoozed_from).toBeNull();
      expect(w.next.snoozed_until).toBeNull();
      expect(w.next.snooze_count).toBe(1);
      expect(w.next.holder_id).toBe(OWN);
    }
  });
  it("wake falls back to accepted when snoozed_from is missing", () => {
    expect(go(mk({ state: "snoozed", snoozed_from: null }), { kind: "wake" }, "system").next.state).toBe("accepted");
  });
  it("wake only by system, only on snoozed asks", () => {
    for (const actor of [OWN, REQ, STR]) denied(mk({ state: "snoozed" }), { kind: "wake" }, actor);
    for (const state of ALL_STATES.filter((s) => s !== "snoozed")) denied(mk({ state }), { kind: "wake" }, "system");
  });
  it("snooze in the past or exactly now is denied", () => {
    denied(mk({ state: "accepted" }), { kind: "snooze", until: NOW - 1 }, OWN);
    denied(mk({ state: "accepted" }), { kind: "snooze", until: NOW }, OWN);
    expect(go(mk({ state: "accepted" }), { kind: "snooze", until: NOW + 1 }, OWN).next.state).toBe("snoozed");
  });
  it("accept_now from snoozed clears snooze fields", () => {
    const r = go(mk({ state: "snoozed" }), { kind: "accept_now" }, OWN).next;
    expect(r.state).toBe("in_progress");
    expect(r.snoozed_until).toBeNull();
    expect(r.snoozed_from).toBeNull();
  });
  it("accept_now sets accepted_at once and does not overwrite it", () => {
    expect(go(mk({ state: "proposed" }), { kind: "accept_now" }, OWN).next.accepted_at).toBe(NOW);
    expect(go(mk({ state: "accepted", accepted_at: 42 }), { kind: "accept_now" }, OWN).next.accepted_at).toBe(42);
  });
});

describe("deadlines", () => {
  it("accept_later only from proposed", () => {
    for (const state of ["in_progress", "accepted", "snoozed"] as AskState[]) {
      denied(mk({ state }), { kind: "accept_later", deadlineAt: NOW + 1 }, OWN);
    }
  });
  it("accept_later with a date: state accepted, deadline set, DM requester; no change-count bump", () => {
    const r = go(mk(), { kind: "accept_later", deadlineAt: NOW + HOUR }, OWN);
    expect(r.next.state).toBe("accepted");
    expect(r.next.deadline_at).toBe(NOW + HOUR);
    expect(r.next.deadline_change_count).toBe(0);
    expect(r.next.accepted_at).toBe(NOW);
    expect(r.dm).toEqual({ userId: REQ, template: "deadline_changed" });
  });
  it("accept_later with no date: no DM", () => {
    const r = go(mk(), { kind: "accept_later", deadlineAt: null }, OWN);
    expect(r.next.state).toBe("accepted");
    expect(r.next.deadline_at).toBeNull();
    expect(r.dm).toBeNull();
  });
  it("set_deadline is denied on proposed", () => {
    denied(mk({ state: "proposed" }), { kind: "set_deadline", deadlineAt: NOW + 1 }, OWN);
  });
  it("first set (null -> date) does not bump the change count, but DMs the requester", () => {
    const r = go(mk({ state: "accepted" }), { kind: "set_deadline", deadlineAt: NOW + HOUR }, OWN);
    expect(r.next.deadline_change_count).toBe(0);
    expect(r.next.deadline_at).toBe(NOW + HOUR);
    expect(r.dm).toEqual({ userId: REQ, template: "deadline_changed" });
  });
  it("replacing a non-null deadline bumps the count each time; DM every time", () => {
    let a = go(mk({ state: "in_progress" }), { kind: "set_deadline", deadlineAt: 100 }, OWN).next;
    for (let i = 1; i <= 4; i++) {
      const r = go(a, { kind: "set_deadline", deadlineAt: 100 + i }, OWN);
      a = r.next;
      expect(a.deadline_change_count).toBe(i);
      expect(r.dm).toEqual({ userId: REQ, template: "deadline_changed" });
    }
  });
  it("clearing a deadline (date -> null) counts as a change", () => {
    const r = go(mk({ state: "accepted", deadline_at: 100 }), { kind: "set_deadline", deadlineAt: null }, OWN);
    expect(r.next.deadline_at).toBeNull();
    expect(r.next.deadline_change_count).toBe(1);
    expect(r.dm).not.toBeNull();
  });
  it("setting the same deadline (including null -> null) is denied", () => {
    denied(mk({ state: "accepted", deadline_at: 100 }), { kind: "set_deadline", deadlineAt: 100 }, OWN);
    denied(mk({ state: "accepted", deadline_at: null }), { kind: "set_deadline", deadlineAt: null }, OWN);
  });
  it("set_deadline works while snoozed and keeps it snoozed", () => {
    const r = go(mk({ state: "snoozed" }), { kind: "set_deadline", deadlineAt: 5 }, OWN);
    expect(r.next.state).toBe("snoozed");
  });
  it("deadline is lost on put_back and redirect (reset)", () => {
    expect(go(mk({ state: "delivered", deadline_at: 5 }), { kind: "put_back", note: "n" }, REQ).next.deadline_at).toBeNull();
    expect(go(mk({ state: "accepted", deadline_at: 5 }), { kind: "redirect", toUserId: NEW }, OWN).next.deadline_at).toBeNull();
  });
});

describe("reject / send_back / set_estimate", () => {
  it("reason is optional: undefined, empty and whitespace all give null", () => {
    for (const reason of [undefined, "", "   \n\t "]) {
      const r = go(mk(), { kind: "reject", reason }, OWN);
      expect(r.note).toBeNull();
      expect(r.next.last_note).toBeNull();
      expect(r.next.state).toBe("rejected");
      expect(r.dm).toEqual({ userId: REQ, template: "ask_rejected" });
    }
  });
  it("reason is trimmed", () => {
    expect(go(mk(), { kind: "reject", reason: "  marketing owns it " }, OWN).note).toBe("marketing owns it");
  });
  it("send_back stores the question and DMs requester", () => {
    const r = go(mk(), { kind: "send_back", question: "which account?" }, OWN);
    expect(r.next.state).toBe("clarify");
    expect(r.next.last_note).toBe("which account?");
    expect(r.dm).toEqual({ userId: REQ, template: "ask_clarify" });
  });
  it("set_estimate flips the source to owner, changes only supplied fields, no state change", () => {
    const r = go(mk({ state: "accepted" }), { kind: "set_estimate", size: "days" }, OWN).next;
    expect(r.size).toBe("days");
    expect(r.size_source).toBe("owner");
    expect(r.urgency_source).toBe("llm");
    expect(r.state).toBe("accepted");
    const u = go(mk(), { kind: "set_estimate", urgency: "urgent" }, OWN).next;
    expect(u.urgency).toBe("urgent");
    expect(u.urgency_source).toBe("owner");
    expect(u.size_source).toBe("llm");
  });
});

describe("purity", () => {
  it("does not mutate the input ask; bumps updated_at to now", () => {
    const ask = mk({ state: "in_progress" });
    const copy = { ...ask };
    const r = go(ask, { kind: "done" }, OWN);
    expect(ask).toEqual(copy);
    expect(r.next.updated_at).toBe(NOW);
    expect(r.eventKind).toBe("done");
  });
});

describe("availableActions agrees with transition()", () => {
  const OWNER_ONLY: AskAction["kind"][] = [
    "accept_now", "accept_later", "done", "ack", "reject", "send_back", "set_deadline", "snooze", "set_estimate",
  ];
  const REQUESTER_ONLY: AskAction["kind"][] = ["close", "put_back", "withdraw"];
  const SHARED: AskAction["kind"][] = ["redirect"];

  const viewers: [string, { requester_id: string; owner_id: string }, string][] = [
    ["owner", { requester_id: REQ, owner_id: OWN }, OWN],
    ["requester", { requester_id: REQ, owner_id: OWN }, REQ],
    ["stranger", { requester_id: REQ, owner_id: OWN }, STR],
    ["self-ask", { requester_id: REQ, owner_id: REQ }, REQ],
  ];

  const params = (kind: AskAction["kind"], ask: AskRow): AskAction => {
    const a = actionsFor(ask).find((x) => x.kind === kind);
    return a!;
  };

  for (const state of ALL_STATES) {
    for (const [label, people, viewer] of viewers) {
      for (const dl of [null, 500]) {
        it(`${state} / ${label} / deadline=${dl}`, () => {
          // deliverable type so done vs ack ambiguity does not matter here (covered below)
          const ask = mk({ state, ...people, deadline_at: dl, holder_id: undefined as never });
          ask.holder_id = REQUESTER_PLATE_STATES.includes(state) ? ask.requester_id : ask.owner_id;
          const listed = availableActions(ask, viewer);
          expect(new Set(listed).size).toBe(listed.length); // no duplicates
          for (const kind of listed) {
            expect(() => transition(ask, params(kind, ask), viewer, NOW), `listed ${kind} should be accepted`).not.toThrow();
          }
          for (const kind of [...OWNER_ONLY, ...REQUESTER_ONLY, ...SHARED]) {
            if (listed.includes(kind)) continue;
            // known permissive overlaps, asserted separately below
            if (kind === "ack" || kind === "done") continue; // done/ack are interchangeable for any type
            if (kind === "accept_now" && state === "in_progress") continue; // no-op re-accept
            expect(() => transition(ask, params(kind, ask), viewer, NOW), `unlisted ${kind} should be denied`).toThrow(TransitionError);
          }
        });
      }
    }
  }

  it("deliverable asks also accept ack (type is not enforced by transition)", () => {
    expect(go(mk({ type: "deliverable" }), { kind: "ack", nextStep: "x" }, OWN).next.state).toBe("delivered");
  });

  // Spec mismatch (minor): accept_now on an in_progress ask is a silent no-op that is not offered as a button.
  it("accept_now on an already in_progress ask is denied", () => {
    denied(mk({ state: "in_progress" }), { kind: "accept_now" }, OWN);
  });

  it("acknowledge asks list ack (not done) but transition accepts both", () => {
    const ask = mk({ type: "acknowledge" });
    const l = availableActions(ask, OWN);
    expect(l).toContain("ack");
    expect(l).not.toContain("done");
    expect(go(ask, { kind: "done" }, OWN).next.state).toBe("delivered");
    expect(availableActions(mk({ type: "deliverable" }), OWN)).toContain("done");
    expect(availableActions(mk({ type: "deliverable" }), OWN)).not.toContain("ack");
  });

  it("concrete button sets", () => {
    expect(availableActions(mk({ state: "proposed" }), OWN)).toEqual([
      "accept_now", "accept_later", "done", "reject", "send_back", "redirect", "snooze", "set_estimate",
    ]);
    expect(availableActions(mk({ state: "in_progress" }), OWN)).not.toContain("accept_now");
    expect(availableActions(mk({ state: "delivered" }), REQ)).toEqual(["close", "put_back", "redirect", "withdraw"]);
    expect(availableActions(mk({ state: "proposed" }), REQ)).toEqual(["redirect", "withdraw"]);
    expect(availableActions(mk({ state: "accepted" }), REQ)).toEqual(["withdraw"]);
    expect(availableActions(mk({ state: "delivered" }), OWN)).toEqual([]);
    expect(availableActions(mk({ state: "delivered" }), STR)).toEqual([]);
  });
});

describe("self-asks (requester === owner)", () => {
  const me = "U_ME";
  const self = (state: AskState = "proposed") => mk({ state, requester_id: me, owner_id: me });

  it("the same person can walk the whole lifecycle", () => {
    let a = self();
    a = go(a, { kind: "accept_now" }, me).next;
    a = go(a, { kind: "done" }, me).next;
    expect(a.state).toBe("delivered");
    expect(a.holder_id).toBe(me);
    a = go(a, { kind: "close" }, me).next;
    expect(a.state).toBe("closed");
  });
  it("owner-plate actions work only on owner-plate states; requester actions only on requester-plate", () => {
    denied(self("delivered"), { kind: "accept_now" }, me);
    denied(self("proposed"), { kind: "close" }, me);
    expect(go(self("rejected"), { kind: "put_back", note: "n" }, me).next.state).toBe("proposed");
  });
  it("done DMs the person themselves (documented: no self-suppression in the state machine)", () => {
    expect(go(self("in_progress"), { kind: "done" }, me).dm).toEqual({ userId: me, template: "ask_delivered" });
  });
  it("redirect to someone else works from either plate", () => {
    expect(go(self("accepted"), { kind: "redirect", toUserId: NEW }, me).next.owner_id).toBe(NEW);
    expect(go(self("delivered"), { kind: "redirect", toUserId: NEW }, me).next.owner_id).toBe(NEW);
  });
  it("withdraw works and notifies the 'owner' (themselves) when on owner plate", () => {
    const r = go(self("accepted"), { kind: "withdraw" }, me);
    expect(r.next.state).toBe("withdrawn");
    expect(r.dm).toEqual({ userId: me, template: "ask_withdrawn" });
  });
});
