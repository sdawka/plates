// One way to lay out an ask's actions on every surface (Home tab, DMs): the most useful few as buttons,
// the rest behind an overflow menu, so a card never shows six buttons in a row. Pure.

import { availableActions } from "../domain/transitions";
import type { AskRow, AskState } from "../types";
import { ACTION_LABEL, askActionId, type AskActionKind } from "./actions";

export type Block = Record<string, unknown>;

/** action_id of the overflow / select menu that carries `ask:<kind>|<askId>` values. */
export const ASK_MENU_ACTION_ID = "ask:overflow";

export const MAX_VISIBLE_BUTTONS = 3;
const MAX_OVERFLOW = 5;
const BUTTON_MAX = 75;

const clamp = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

export const STYLE: Partial<Record<AskActionKind, "primary" | "danger">> = {
  accept_now: "primary",
  done: "primary",
  ack: "primary",
  close: "primary",
};

export const button = (kind: AskActionKind, askId: string, label = ACTION_LABEL[kind]): Block => ({
  type: "button",
  action_id: askActionId(kind),
  text: { type: "plain_text", text: clamp(label, BUTTON_MAX), emoji: true },
  value: askId,
  ...(STYLE[kind] ? { style: STYLE[kind] } : {}),
});

export const overflow = (kinds: AskActionKind[], askId: string, labels: Partial<Record<AskActionKind, string>> = {}): Block => ({
  type: "overflow",
  action_id: ASK_MENU_ACTION_ID,
  options: kinds.map((kind) => ({
    text: { type: "plain_text", text: clamp(labels[kind] ?? ACTION_LABEL[kind], BUTTON_MAX), emoji: true },
    value: `ask:${kind}|${askId}`,
  })),
});

/** Preferred visible actions per state, most relevant first; the rest go to the overflow menu. */
const PREFERRED: Partial<Record<AskState, AskActionKind[]>> = {
  proposed: ["accept_now", "accept_later", "reject"],
  accepted: ["accept_now", "done", "ack", "snooze"],
  in_progress: ["done", "ack", "snooze", "set_deadline"],
  snoozed: ["accept_now", "done", "ack", "set_deadline"],
  delivered: ["close", "put_back"],
  rejected: ["put_back", "redirect", "close"],
  clarify: ["put_back", "redirect", "withdraw"],
};

/** An acknowledgement is answered, not worked on: lead with Acknowledge while it's still proposed. */
const PREFERRED_ACK_PROPOSED: AskActionKind[] = ["ack", "accept_now", "reject"];

export function preferredActions(ask: AskRow): AskActionKind[] {
  if (ask.state === "proposed" && ask.type === "acknowledge") return PREFERRED_ACK_PROPOSED;
  return PREFERRED[ask.state] ?? [];
}

/** Every action `viewer` may take, preferred ones first. */
export function orderActions(ask: AskRow, viewer: string): AskActionKind[] {
  const available = availableActions(ask, viewer);
  const preferred = preferredActions(ask).filter((k) => available.includes(k));
  return [...preferred, ...available.filter((k) => !preferred.includes(k))];
}

/**
 * Lays out `kinds` (already in display order) as up to `maxVisible` buttons plus an overflow menu.
 * A lone leftover action stays a button. Null when there is nothing to show.
 */
export function fitActions(
  kinds: AskActionKind[],
  askId: string,
  blockId: string,
  labels: Partial<Record<AskActionKind, string>> = {},
  maxVisible = MAX_VISIBLE_BUTTONS,
): Block | null {
  if (kinds.length === 0) return null;
  const fitsAsButtons = kinds.length <= maxVisible + 1;
  const visible = fitsAsButtons ? kinds : kinds.slice(0, maxVisible);
  const rest = fitsAsButtons ? [] : kinds.slice(maxVisible, maxVisible + MAX_OVERFLOW);
  const elements = visible.map((k) => button(k, askId, labels[k]));
  if (rest.length > 0) elements.push(overflow(rest, askId, labels));
  return { type: "actions", block_id: blockId, elements };
}

/** The viewer's actions on an ask, laid out with `fitActions`. */
export function actionsBlock(ask: AskRow, viewer: string, blockId: string, maxVisible = MAX_VISIBLE_BUTTONS): Block | null {
  return fitActions(orderActions(ask, viewer), ask.id, blockId, {}, maxVisible);
}
