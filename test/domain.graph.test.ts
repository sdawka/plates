import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RULES, STATE_GRAPH, transition, type ActionKind, type Role } from "../src/domain/transitions";
import { renderStateDiagram } from "../src/domain/diagram";
import { ASK_STATES, TransitionError, type AskAction, type AskRow, type AskState } from "../src/types";

const NOW = 1_800_000_000_000;
const ACTOR: Record<Role | "stranger", string> = { owner: "UOWN", requester: "UREQ", system: "system", stranger: "UX" };

const ask = (state: AskState): AskRow => ({
  id: "a1", request_id: "r1", requester_id: ACTOR.requester, owner_id: ACTOR.owner,
  holder_id: ["delivered", "rejected", "clarify"].includes(state) ? ACTOR.requester : ACTOR.owner,
  title: "t", detail: null, type: "deliverable", state, snoozed_from: state === "snoozed" ? "accepted" : null,
  size: "lt1h", size_source: "llm", urgency: "normal", urgency_source: "llm", estimate_reason: null,
  inferred_due_at: null, deadline_at: null, deadline_change_count: 0,
  snoozed_until: state === "snoozed" ? NOW + 1000 : null, snooze_count: 0, round_count: 0, source_ts: null,
  source_permalink: null, next_step: null, done_link: null, last_note: null, created_at: 0, accepted_at: null,
  closed_at: null, updated_at: 0, reminder_stage: 0, last_reminded_at: null, last_bumped_at: null,
  tracker_ref: null, tracker_url: null,
});

/** A valid payload for each action, so only the rules decide the outcome. */
const PAYLOAD: { [K in ActionKind]: Extract<AskAction, { kind: K }> } = {
  accept_now: { kind: "accept_now" },
  accept_later: { kind: "accept_later", deadlineAt: null },
  done: { kind: "done" },
  ack: { kind: "ack", nextStep: "next" },
  reject: { kind: "reject" },
  send_back: { kind: "send_back", question: "q?" },
  set_deadline: { kind: "set_deadline", deadlineAt: NOW + 86_400_000 },
  snooze: { kind: "snooze", until: NOW + 3_600_000 },
  set_estimate: { kind: "set_estimate", size: "hours" },
  redirect: { kind: "redirect", toUserId: "UNEW" },
  close: { kind: "close" },
  put_back: { kind: "put_back", note: "more please" },
  withdraw: { kind: "withdraw" },
  wake: { kind: "wake" },
};

describe("the state machine is exactly STATE_GRAPH", () => {
  const kinds = Object.keys(RULES) as ActionKind[];
  const cases = ASK_STATES.flatMap((state) =>
    kinds.flatMap((kind) => (Object.keys(ACTOR) as (keyof typeof ACTOR)[]).map((who) => ({ state, kind, who }))),
  );

  it.each(cases)("$who $kind from $state", ({ state, kind, who }) => {
    const edge = STATE_GRAPH.find((e) => e.from === state && e.action === kind && e.by === who);
    const run = () => transition(ask(state), PAYLOAD[kind], ACTOR[who], NOW);
    if (!edge) {
      expect(run).toThrow(TransitionError);
      return;
    }
    const { next } = run();
    const expected = edge.to === "unchanged" ? state : edge.to === "pre_snooze" ? "accepted" : edge.to;
    expect(next.state).toBe(expected);
  });

  it("every denial carries a message for the person", () => {
    for (const { state, kind, who } of cases) {
      try {
        transition(ask(state), PAYLOAD[kind], ACTOR[who], NOW);
      } catch (e) {
        expect((e as TransitionError).userMessage, `${who} ${kind} ${state}`).toMatch(/\w/);
      }
    }
  });

  it("ended states have no way out", () => {
    expect(STATE_GRAPH.filter((e) => e.from === "closed" || e.from === "withdrawn")).toEqual([]);
  });

  it("only the requester ends an ask", () => {
    const ending = STATE_GRAPH.filter((e) => e.to === "closed" || e.to === "withdrawn");
    expect(new Set(ending.map((e) => e.by))).toEqual(new Set(["requester"]));
  });

  it("docs/state-machine.md is up to date (npm run diagram)", () => {
    expect(readFileSync("docs/state-machine.md", "utf8")).toBe(renderStateDiagram());
  });
});
