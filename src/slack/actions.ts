// Block Kit action_id and callback_id conventions shared by the renderers (thread message, DMs,
// Home tab) and the interaction handlers in src/index.ts.
//
// Ask buttons:     action_id = `ask:<AskAction kind>`,  value = askId
// Request buttons: action_id = `req:<verb>`,            value = requestId
// Modals:          callback_id = `modal:<AskAction kind>`, private_metadata = JSON ModalMeta

import type { AskAction } from "../types";

export type AskActionKind = AskAction["kind"];

export const askActionId = (kind: AskActionKind) => `ask:${kind}` as const;
export const parseAskActionId = (actionId: string): AskActionKind | null =>
  actionId.startsWith("ask:") ? (actionId.slice(4) as AskActionKind) : null;

export const REQ_ACTIONS = {
  confirm: "req:confirm", // value = requestId (Home "Unconfirmed" section, confirmation message button)
  edit: "req:edit", // opens a modal to fix people / items
  openThread: "req:open_thread", // link button, no handler needed
} as const;

/** Actions that need input → open a modal. Others apply immediately on click. */
export const NEEDS_MODAL: ReadonlySet<AskActionKind> = new Set<AskActionKind>([
  "accept_later", // deadline (optional)
  "done", // optional link / note
  "ack", // next step
  "reject", // optional reason (always asked)
  "send_back", // question
  "set_deadline",
  "snooze", // preset or custom time
  "set_estimate",
  "redirect", // user picker
  "put_back", // note
  "withdraw", // optional note
]);

export const modalCallbackId = (kind: AskActionKind) => `modal:${kind}` as const;
export const parseModalCallbackId = (id: string): AskActionKind | null =>
  id.startsWith("modal:") ? (id.slice(6) as AskActionKind) : null;

export interface ModalMeta {
  askId: string;
  via: "button" | "home" | "dm";
}

/** Button labels, phrased for the person who sees them. */
export const ACTION_LABEL: Record<AskActionKind, string> = {
  accept_now: "Accept · now",
  accept_later: "Accept · later",
  done: "Done",
  ack: "Ack + next step",
  reject: "Reject",
  send_back: "Need more info",
  set_deadline: "Set deadline",
  snooze: "Snooze",
  set_estimate: "Change size/urgency",
  redirect: "Redirect",
  close: "Close",
  put_back: "Put back",
  withdraw: "Withdraw",
  wake: "Wake",
};

export const CONFIRM_REACTIONS = {
  yes: ["white_check_mark", "heavy_check_mark", "+1", "ballot_box_with_check"],
  no: ["x", "-1", "heavy_multiplication_x", "negative_squared_cross_mark"],
} as const;
