// Pure state machine for an ask. No I/O: given an ask, an action and an actor,
// return the patched ask plus which DM (if any) the move should trigger.
//
// The machine is enumerable: RULES says, for every action, who may take it from which states
// and where it lands. transition() checks RULES before applying the action's field changes,
// availableActions() reads RULES to pick buttons, and STATE_GRAPH lists every edge.

import {
  ASK_STATES,
  OWNER_PLATE_STATES,
  REQUESTER_PLATE_STATES,
  TERMINAL_STATES,
  TransitionError,
  type Actor,
  type AskAction,
  type AskRow,
  type AskState,
  type DmTemplate,
} from "../types";

export type ActionKind = AskAction["kind"];
export type Role = "owner" | "requester" | "system";

/** Where an action lands: a fixed state, the same state, or the state the snooze interrupted. */
export type Target = AskState | "unchanged" | "pre_snooze";

export interface Rule {
  /** Per role, the states from which that role may take the action. A role that's absent may never take it. */
  from: Partial<Record<Role, readonly AskState[]>>;
  to: Target;
  /** Message when the actor has none of the allowed roles. */
  notYours?: string;
  /** Message when the role is right but the state isn't, by state; then `wrongStateDefault`; then the role's default. */
  wrongState?: Partial<Record<AskState, string>>;
  wrongStateDefault?: string;
}

const OWNER = OWNER_PLATE_STATES;
const REQUESTER = REQUESTER_PLATE_STATES;
const OPEN: readonly AskState[] = [...OWNER, ...REQUESTER];

export const RULES: { readonly [K in ActionKind]: Rule } = {
  accept_now: { from: { owner: ["proposed", "accepted", "snoozed"] }, to: "in_progress", wrongState: { in_progress: "You're already on it." } },
  accept_later: { from: { owner: ["proposed"] }, to: "accepted", wrongState: { accepted: "This ask is already accepted.", in_progress: "This ask is already accepted.", snoozed: "This ask is already accepted." } },
  done: { from: { owner: OWNER }, to: "delivered" },
  ack: { from: { owner: OWNER }, to: "delivered" },
  reject: { from: { owner: OWNER }, to: "rejected" },
  send_back: { from: { owner: OWNER }, to: "clarify" },
  set_deadline: { from: { owner: ["accepted", "in_progress", "snoozed"] }, to: "unchanged", wrongState: { proposed: "Accept the ask first, then set a deadline." } },
  snooze: { from: { owner: OWNER }, to: "snoozed" },
  set_estimate: { from: { owner: OWNER }, to: "unchanged" },
  redirect: { from: { owner: OWNER, requester: [...REQUESTER, "proposed"] }, to: "proposed", notYours: "You can't redirect this ask right now.", wrongStateDefault: "You can't redirect this ask right now." },
  close: { from: { requester: REQUESTER }, to: "closed" },
  put_back: { from: { requester: REQUESTER }, to: "proposed" },
  withdraw: { from: { requester: OPEN }, to: "withdrawn", notYours: "Only the person who asked can withdraw it." },
  wake: { from: { system: ["snoozed"] }, to: "pre_snooze" },
};

const NOT_ROLE: Record<Role, string> = {
  owner: "Only the person this was asked of can do that.",
  requester: "Only the person who asked can do that.",
  system: "Not allowed.",
};
const WRONG_STATE: Record<Role, string> = {
  owner: "This ask isn't on your plate right now.",
  requester: "That isn't possible for this ask right now.",
  system: "Not snoozed.",
};

export interface Edge {
  from: AskState;
  action: ActionKind;
  by: Role;
  to: AskState | "unchanged" | "pre_snooze";
}

/** Every allowed (state, action, role) edge, for docs, diagrams and exhaustive tests. */
export const STATE_GRAPH: readonly Edge[] = (Object.keys(RULES) as ActionKind[]).flatMap((action) =>
  (Object.entries(RULES[action].from) as [Role, readonly AskState[]][]).flatMap(([by, states]) =>
    states.map((from) => ({ from, action, by, to: RULES[action].to })),
  ),
);

export function rolesOf(ask: AskRow, actor: Actor): Role[] {
  if (actor === "system") return ["system"];
  const roles: Role[] = [];
  if (actor === ask.owner_id) roles.push("owner");
  if (actor === ask.requester_id) roles.push("requester");
  return roles;
}

/** True when RULES lets `actor` take `kind` on `ask` in its current state. */
export function isAllowed(ask: AskRow, kind: ActionKind, actor: Actor): boolean {
  const from = RULES[kind].from;
  return rolesOf(ask, actor).some((r) => from[r]?.includes(ask.state));
}

function deny(why: string, userMessage: string): never {
  throw new TransitionError(why, userMessage);
}

function authorize(ask: AskRow, kind: ActionKind, actor: Actor): void {
  if (TERMINAL_STATES.includes(ask.state)) deny(`ask ${ask.id} already ${ask.state}`, "This ask is already finished.");
  const rule = RULES[kind];
  const eligible = rolesOf(ask, actor).filter((r) => rule.from[r]);
  if (eligible.length === 0) {
    const only = Object.keys(rule.from) as Role[];
    deny(`${actor} may not ${kind}`, rule.notYours ?? NOT_ROLE[only[0]!]);
  }
  if (!eligible.some((r) => rule.from[r]!.includes(ask.state))) {
    deny(`${kind} not allowed from ${ask.state}`, rule.wrongState?.[ask.state] ?? rule.wrongStateDefault ?? WRONG_STATE[eligible[0]!]);
  }
}

/** Actions whose words replace the ask's latest note. Close keeps the owner's last words visible. */
const WRITES_LAST_NOTE: ReadonlySet<ActionKind> = new Set(["done", "ack", "reject", "send_back", "redirect", "put_back", "withdraw"]);

export interface TransitionResult {
  next: AskRow;
  eventKind: string;
  note: string | null;
  dm: { userId: string; template: DmTemplate } | null;
}

export function transition(ask: AskRow, action: AskAction, actor: Actor, now: number): TransitionResult {
  if (action.kind === "redirect" && action.toUserId === ask.owner_id && OWNER.includes(ask.state)) {
    deny("redirect to same owner", "They already have it.");
  }
  authorize(ask, action.kind, actor);

  const target = RULES[action.kind].to;
  const next: AskRow = { ...ask, updated_at: now };
  if (target === "pre_snooze") next.state = ask.snoozed_from ?? "accepted";
  else if (target !== "unchanged") next.state = target;

  // Leaving the owner's plate (or the machine) clears the snooze; so does starting work.
  if (target !== "unchanged" && target !== "snoozed") {
    next.snoozed_until = null;
    next.snoozed_from = null;
  }
  if (REQUESTER.includes(next.state)) next.holder_id = ask.requester_id;

  let dm: TransitionResult["dm"] = null;
  let note: string | null = null;
  const toRequester = (template: DmTemplate) => (dm = { userId: ask.requester_id, template });

  switch (action.kind) {
    case "accept_now":
      next.accepted_at ??= now;
      break;

    case "accept_later":
      next.accepted_at = now;
      next.deadline_at = action.deadlineAt;
      if (action.deadlineAt !== null) toRequester("deadline_changed");
      break;

    case "done":
      next.done_link = action.link ?? null;
      note = action.note ?? null;
      toRequester("ask_delivered");
      break;

    case "ack":
      next.next_step = action.nextStep;
      note = action.nextStep;
      toRequester("ask_delivered");
      break;

    case "reject":
      note = action.reason?.trim() || null;
      toRequester("ask_rejected");
      break;

    case "send_back":
      note = action.question;
      toRequester("ask_clarify");
      break;

    case "set_deadline":
      if (action.deadlineAt === ask.deadline_at) deny("deadline unchanged", "That's already the deadline.");
      if (ask.deadline_at !== null) next.deadline_change_count = ask.deadline_change_count + 1;
      next.deadline_at = action.deadlineAt;
      toRequester("deadline_changed");
      break;

    case "snooze":
      if (action.until <= now) deny("snooze in the past", "Pick a time in the future.");
      next.snoozed_from = ask.state === "snoozed" ? ask.snoozed_from : ask.state;
      next.snoozed_until = action.until;
      next.snooze_count = ask.snooze_count + 1;
      break;

    case "set_estimate":
      if (action.size) {
        next.size = action.size;
        next.size_source = "owner";
      }
      if (action.urgency) {
        next.urgency = action.urgency;
        next.urgency_source = "owner";
      }
      break;

    case "redirect":
      next.owner_id = action.toUserId;
      next.holder_id = action.toUserId;
      next.deadline_at = null;
      next.accepted_at = null;
      note = action.note ?? null;
      dm = { userId: action.toUserId, template: "ask_proposed" };
      break;

    case "close":
      next.closed_at = now;
      note = action.note ?? null;
      break;

    case "put_back":
      next.holder_id = ask.owner_id;
      next.round_count = ask.round_count + 1;
      next.deadline_at = null;
      next.accepted_at = null;
      note = action.note;
      dm = { userId: ask.owner_id, template: "ask_proposed" };
      break;

    case "withdraw":
      next.closed_at = now;
      note = action.note ?? null;
      if (OWNER.includes(ask.state)) dm = { userId: ask.owner_id, template: "ask_withdrawn" };
      break;

    case "wake":
      break;

    default: {
      const unreachable: never = action;
      throw new Error(`unknown action ${JSON.stringify(unreachable)}`);
    }
  }

  if (WRITES_LAST_NOTE.has(action.kind)) next.last_note = note;

  return { next, eventKind: action.kind, note, dm };
}

/** Button order per role; the first few become buttons, the rest go in the overflow menu. */
const BUTTON_ORDER: Record<Exclude<Role, "system">, ActionKind[]> = {
  owner: ["accept_now", "accept_later", "done", "ack", "reject", "send_back", "redirect", "snooze", "set_estimate", "set_deadline"],
  requester: ["close", "put_back", "redirect", "withdraw"],
};

/** Which actions a given viewer may take on an ask right now, in button order. */
export function availableActions(ask: AskRow, viewer: string): ActionKind[] {
  const out = new Set<ActionKind>();
  for (const role of rolesOf(ask, viewer)) {
    if (role === "system") continue;
    for (const kind of BUTTON_ORDER[role]) {
      if (!RULES[kind].from[role]?.includes(ask.state)) continue;
      // Display choice, not a rule: acknowledgements get "Ack + next step", everything else "Done".
      if (kind === "done" && ask.type === "acknowledge") continue;
      if (kind === "ack" && ask.type !== "acknowledge") continue;
      out.add(kind);
    }
  }
  return [...out];
}

/** For tests: every state the machine knows. */
export const ALL_STATES: readonly AskState[] = ASK_STATES;
