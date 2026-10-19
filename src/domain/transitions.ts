// Pure state machine for an ask. No I/O: given an ask, an action and an actor,
// return the patched ask plus which DM (if any) the move should trigger.

import {
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

export interface TransitionResult {
  next: AskRow;
  eventKind: string;
  note: string | null;
  dm: { userId: string; template: DmTemplate } | null;
}

const ownerPlate = (s: AskState) => OWNER_PLATE_STATES.includes(s);
const requesterPlate = (s: AskState) => REQUESTER_PLATE_STATES.includes(s);
const ended = (s: AskState) => TERMINAL_STATES.includes(s);

function deny(why: string, userMessage: string): never {
  throw new TransitionError(why, userMessage);
}

export function transition(ask: AskRow, action: AskAction, actor: Actor, now: number): TransitionResult {
  if (ended(ask.state)) deny(`ask ${ask.id} already ${ask.state}`, "This ask is already finished.");

  const isOwner = actor === ask.owner_id;
  const isRequester = actor === ask.requester_id;
  const requireOwner = () => {
    if (!isOwner) deny(`${actor} is not owner`, "Only the person this was asked of can do that.");
    if (!ownerPlate(ask.state)) deny(`state ${ask.state} not on owner plate`, "This ask isn't on your plate right now.");
  };
  const requireRequester = (from: readonly AskState[]) => {
    if (!isRequester) deny(`${actor} is not requester`, "Only the person who asked can do that.");
    if (!from.includes(ask.state)) deny(`state ${ask.state} not allowed`, "That isn't possible for this ask right now.");
  };

  const next: AskRow = { ...ask, updated_at: now };
  const toRequester = (state: AskState): void => {
    next.state = state;
    next.holder_id = ask.requester_id;
    next.snoozed_until = null;
    next.snoozed_from = null;
  };
  let dm: TransitionResult["dm"] = null;
  let note: string | null = null;

  switch (action.kind) {
    case "accept_now":
      requireOwner();
      if (ask.state === "in_progress") deny("accept_now on in_progress", "You're already on it.");
      next.state = "in_progress";
      next.snoozed_until = null;
      next.snoozed_from = null;
      next.accepted_at ??= now;
      break;

    case "accept_later":
      requireOwner();
      if (ask.state !== "proposed") deny("accept_later only from proposed", "This ask is already accepted.");
      next.state = "accepted";
      next.accepted_at = now;
      next.deadline_at = action.deadlineAt;
      if (action.deadlineAt !== null) dm = { userId: ask.requester_id, template: "deadline_changed" };
      break;

    case "done":
      requireOwner();
      toRequester("delivered");
      next.done_link = action.link ?? null;
      note = action.note ?? null;
      next.last_note = note;
      dm = { userId: ask.requester_id, template: "ask_delivered" };
      break;

    case "ack":
      requireOwner();
      toRequester("delivered");
      next.next_step = action.nextStep;
      note = action.nextStep;
      next.last_note = note;
      dm = { userId: ask.requester_id, template: "ask_delivered" };
      break;

    case "reject":
      requireOwner();
      toRequester("rejected");
      note = action.reason?.trim() || null;
      next.last_note = note;
      dm = { userId: ask.requester_id, template: "ask_rejected" };
      break;

    case "send_back":
      requireOwner();
      toRequester("clarify");
      note = action.question;
      next.last_note = note;
      dm = { userId: ask.requester_id, template: "ask_clarify" };
      break;

    case "set_deadline":
      requireOwner();
      if (ask.state === "proposed") deny("set_deadline on proposed", "Accept the ask first, then set a deadline.");
      if (action.deadlineAt === ask.deadline_at) deny("deadline unchanged", "That's already the deadline.");
      if (ask.deadline_at !== null) next.deadline_change_count = ask.deadline_change_count + 1;
      next.deadline_at = action.deadlineAt;
      dm = { userId: ask.requester_id, template: "deadline_changed" };
      break;

    case "snooze":
      requireOwner();
      if (action.until <= now) deny("snooze in the past", "Pick a time in the future.");
      next.snoozed_from = ask.state === "snoozed" ? ask.snoozed_from : ask.state;
      next.state = "snoozed";
      next.snoozed_until = action.until;
      next.snooze_count = ask.snooze_count + 1;
      break;

    case "set_estimate":
      requireOwner();
      if (action.size) {
        next.size = action.size;
        next.size_source = "owner";
      }
      if (action.urgency) {
        next.urgency = action.urgency;
        next.urgency_source = "owner";
      }
      break;

    case "redirect": {
      if (action.toUserId === ask.owner_id && ownerPlate(ask.state)) deny("redirect to same owner", "They already have it.");
      if (isOwner && ownerPlate(ask.state)) {
        // owner hands it to someone else
      } else if (isRequester && (requesterPlate(ask.state) || ask.state === "proposed")) {
        // requester picks a different owner
      } else {
        deny(`${actor} cannot redirect in ${ask.state}`, "You can't redirect this ask right now.");
      }
      next.owner_id = action.toUserId;
      next.holder_id = action.toUserId;
      next.state = "proposed";
      next.snoozed_until = null;
      next.snoozed_from = null;
      next.deadline_at = null;
      next.accepted_at = null;
      note = action.note ?? null;
      next.last_note = note;
      dm = { userId: action.toUserId, template: "ask_proposed" };
      break;
    }

    case "close":
      requireRequester(REQUESTER_PLATE_STATES);
      next.state = "closed";
      next.closed_at = now;
      note = action.note ?? null;
      break;

    case "put_back":
      requireRequester(REQUESTER_PLATE_STATES);
      next.state = "proposed";
      next.holder_id = ask.owner_id;
      next.round_count = ask.round_count + 1;
      next.deadline_at = null;
      next.accepted_at = null;
      note = action.note;
      next.last_note = note;
      dm = { userId: ask.owner_id, template: "ask_proposed" };
      break;

    case "withdraw":
      if (!isRequester) deny(`${actor} is not requester`, "Only the person who asked can withdraw it.");
      next.state = "withdrawn";
      next.closed_at = now;
      next.snoozed_until = null;
      note = action.note ?? null;
      next.last_note = note;
      if (ownerPlate(ask.state)) dm = { userId: ask.owner_id, template: "ask_withdrawn" };
      break;

    case "wake":
      if (actor !== "system") deny("wake is system-only", "Not allowed.");
      if (ask.state !== "snoozed") deny("wake on non-snoozed ask", "Not snoozed.");
      next.state = ask.snoozed_from ?? "accepted";
      next.snoozed_from = null;
      next.snoozed_until = null;
      break;
  }

  return { next, eventKind: action.kind, note, dm };
}

/** Which actions a given viewer may take on an ask right now. Used to render buttons. */
export function availableActions(ask: AskRow, viewer: string): AskAction["kind"][] {
  const out: AskAction["kind"][] = [];
  if (ended(ask.state)) return out;
  if (viewer === ask.owner_id && ownerPlate(ask.state)) {
    if (ask.state !== "in_progress") out.push("accept_now");
    if (ask.state === "proposed") out.push("accept_later");
    out.push(ask.type === "acknowledge" ? "ack" : "done", "reject", "send_back", "redirect", "snooze", "set_estimate");
    if (ask.state !== "proposed") out.push("set_deadline");
  }
  if (viewer === ask.requester_id) {
    if (requesterPlate(ask.state)) out.push("close", "put_back", "redirect");
    else if (ask.state === "proposed" && !out.includes("redirect")) out.push("redirect");
    out.push("withdraw");
  }
  return out;
}
