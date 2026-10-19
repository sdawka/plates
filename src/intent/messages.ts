// Pure Block Kit builders for the conversational layer: applied lines with Undo, "Did you mean"
// and "looks done?" proposals, and their resolved states.

import type { AskAction, AskRow } from "../types";
import { PROPOSAL_ACTIONS, UNDO_ACTION_ID } from "../slack/actions";
import type { Block, Rendered } from "../slack/blocks";
import { dateToken, esc, isHttpUrl, mention, truncate } from "../slack/format";

const plain = (text: string) => ({ type: "plain_text", text, emoji: true });
const section = (text: string): Block => ({ type: "section", text: { type: "mrkdwn", text: truncate(text, 2900) } });
const context = (text: string): Block => ({ type: "context", elements: [{ type: "mrkdwn", text: truncate(text, 2900) }] });
const stripMarkup = (s: string) => s.replace(/[*_~]/g, "").replace(/<!date\^\d+\^[^|>]*\|([^>]*)>/g, "$1");

/** How an action reads in "Did you mean: …?". */
export const ACTION_VERB: Record<AskAction["kind"], string> = {
  accept_now: "Accept now",
  accept_later: "Accept for later",
  done: "Mark done",
  ack: "Ack with next step",
  reject: "Reject",
  send_back: "Send back with a question",
  set_deadline: "Set deadline",
  snooze: "Snooze",
  set_estimate: "Change size/urgency",
  redirect: "Redirect",
  close: "Close",
  put_back: "Put back",
  withdraw: "Withdraw",
  wake: "Wake",
};

/** The value an action carries, as a short mrkdwn fragment (null when it carries none). */
export function actionDetail(action: AskAction): string | null {
  const q = (s: string) => `“${esc(truncate(s, 200))}”`;
  switch (action.kind) {
    case "accept_later": return action.deadlineAt ? `expected ${dateToken(action.deadlineAt)}` : "no date yet";
    case "set_deadline": return action.deadlineAt ? `deadline ${dateToken(action.deadlineAt)}` : "no deadline";
    case "done": return action.link ? (isHttpUrl(action.link) ? `<${action.link}|result>` : esc(action.link)) : action.note ? q(action.note) : null;
    case "ack": return `next step: ${q(action.nextStep)}`;
    case "reject": return action.reason ? q(action.reason) : null;
    case "send_back": return q(action.question);
    case "redirect": return `to ${mention(action.toUserId)}`;
    case "put_back": return q(action.note);
    case "close": case "withdraw": return action.note ? q(action.note) : null;
    default: return null;
  }
}

/** What happened, for the "✓ …" line. `after` is the ask after the transition. */
export function describeResult(action: AskAction, after: AskRow): string {
  switch (action.kind) {
    case "accept_now": return "accepted, working on it";
    case "accept_later": return action.deadlineAt ? `accepted, expected ${dateToken(action.deadlineAt)}` : "accepted, no date yet";
    case "done": return `marked done, now with ${mention(after.requester_id)} to close${action.link ? ` (${isHttpUrl(action.link) ? `<${action.link}|result>` : esc(action.link)})` : ""}`;
    case "ack": return `acknowledged, next step: ${esc(truncate(action.nextStep, 200))}`;
    case "reject": return `rejected${action.reason ? `: ${esc(truncate(action.reason, 200))}` : ""}`;
    case "send_back": return `sent back to ${mention(after.requester_id)}: ${esc(truncate(action.question, 200))}`;
    case "set_deadline": return action.deadlineAt ? `deadline set to ${dateToken(action.deadlineAt)}` : "deadline removed";
    case "redirect": return `redirected to ${mention(action.toUserId)}`;
    case "close": return "closed";
    case "put_back": return `put back on ${mention(after.holder_id)}'s plate`;
    case "withdraw": return "withdrawn";
    case "snooze": return "snoozed";
    case "set_estimate": return "estimate updated";
    case "wake": return "woken up";
  }
}

export function appliedMessage(actor: string, action: AskAction, after: AskRow, eventId: string): Rendered {
  const line = `✓ ${mention(actor)} → *${esc(after.title)}*: ${describeResult(action, after)}`;
  return {
    text: stripMarkup(line),
    blocks: [
      section(line),
      { type: "actions", block_id: `undo:${eventId}`, elements: [{ type: "button", action_id: UNDO_ACTION_ID, text: plain("Undo"), value: eventId }] },
    ],
  };
}

export const undoneMessage = (): Rendered => ({ text: "↩︎ Undone", blocks: [section("↩︎ Undone")] });

export interface ProposalView {
  id: string;
  source: "reply" | "detector";
  actor: string;
  action: AskAction;
  ask: AskRow | null;
  /** Asks the speaker may pick from. */
  options: { id: string; title: string }[];
  /** Show the "Pick ask" menu. */
  picker: boolean;
}

export function proposalMessage(p: ProposalView): Rendered {
  const title = p.ask ? `*${esc(p.ask.title)}*` : null;
  const detail = actionDetail(p.action);
  let line: string;
  let yes = "Yes";
  if (p.source === "detector") {
    line = `${mention(p.actor)} Looks like this delivers ${title ?? "an ask"} — mark it done?`;
    yes = "Yes, mark done";
  } else {
    line = `${mention(p.actor)} Did you mean: ${ACTION_VERB[p.action.kind]} ${title ?? "one of these asks"}?`;
  }
  const elements: Block[] = [
    { type: "button", action_id: PROPOSAL_ACTIONS.yes, style: "primary", text: plain(yes), value: p.id },
    { type: "button", action_id: PROPOSAL_ACTIONS.no, text: plain("No"), value: p.id },
  ];
  if (p.picker && p.options.length > 0) {
    const options = p.options.slice(0, 100).map((o) => ({ text: plain(truncate(o.title, 75)), value: `${p.id}|${o.id}` }));
    const initial = p.ask ? options.find((o) => o.value === `${p.id}|${p.ask!.id}`) : undefined;
    elements.push({
      type: "static_select",
      action_id: PROPOSAL_ACTIONS.pick,
      placeholder: plain("Pick ask"),
      options,
      ...(initial ? { initial_option: initial } : {}),
    });
  }
  return {
    text: stripMarkup(line),
    blocks: [section(line), ...(detail ? [context(detail)] : []), { type: "actions", block_id: `p:${p.id}`, elements }],
  };
}

export const dismissedMessage = (): Rendered => ({ text: "Okay, ignored.", blocks: [section("Okay, ignored.")] });
export const expiredMessage = (): Rendered => ({
  text: "This suggestion expired. Use the buttons on the request instead.",
  blocks: [section("This suggestion expired. Use the buttons on the request instead.")],
});
