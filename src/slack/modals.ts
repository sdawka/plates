// Pure modal builders and submission parsers. One modal per ask action that needs input,
// plus the request edit modal. Every input uses action_id "v" and its block_id as the field name.

import { SIZE_LABEL, type AskAction, type AskRow, type DraftAsk, type RequestRow, type Size, type Urgency } from "../types";
import { ACTION_LABEL, modalCallbackId, type AskActionKind, type ModalMeta } from "./actions";
import { parseDrafts, type Block } from "./blocks";
import { esc, isHttpUrl, truncate } from "./format";
import { dateInTz, endOfDay, snoozeUntil, type SnoozePreset } from "./times";

export const EDIT_CALLBACK_ID = "reqmodal:edit";
export interface EditMeta {
  requestId: string;
}

export interface InputValue {
  value?: string | null;
  selected_date?: string | null;
  selected_date_time?: number | null;
  selected_option?: { value: string } | null;
  selected_options?: { value: string }[] | null;
  selected_user?: string | null;
}
export type ViewValues = Record<string, Record<string, InputValue | undefined> | undefined>;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string> };
const fail = (block: string, msg: string): { ok: false; errors: Record<string, string> } => ({ ok: false, errors: { [block]: msg } });

const URGENCIES: Urgency[] = ["low", "normal", "high", "urgent"];
const SIZES = Object.keys(SIZE_LABEL) as Size[];

/** The block that receives errors that don't belong to a specific field (e.g. a TransitionError). */
export const FIRST_BLOCK: Record<AskActionKind, string> = {
  accept_later: "date", done: "link", ack: "next", reject: "reason", send_back: "question", set_deadline: "date",
  snooze: "preset", set_estimate: "size", redirect: "user", put_back: "note", withdraw: "note",
  accept_now: "note", close: "note", wake: "note",
};

// ---------- element helpers ----------

const plain = (text: string) => ({ type: "plain_text", text, emoji: true });
const section = (text: string): Block => ({ type: "section", text: { type: "mrkdwn", text: truncate(text, 2900) } });

function input(id: string, label: string, element: Block, optional: boolean, hint?: string): Block {
  return {
    type: "input", block_id: id, optional, label: plain(label),
    ...(hint ? { hint: plain(hint) } : {}),
    element: { ...element, action_id: "v" },
  };
}
const textInput = (id: string, label: string, optional: boolean, placeholder?: string, multiline = true): Block =>
  input(id, label, { type: "plain_text_input", multiline, ...(placeholder ? { placeholder: plain(placeholder) } : {}) }, optional);

const option = (text: string, value: string) => ({ text: plain(text), value });

const val = (values: ViewValues, id: string): InputValue | undefined => values[id]?.["v"];
const str = (values: ViewValues, id: string): string => (val(values, id)?.value ?? "").trim();

// ---------- ask modals ----------

function askBlocks(kind: AskActionKind, ask: AskRow, tz: string): Block[] {
  const intro = section(`*${esc(ask.title)}*`);
  switch (kind) {
    case "accept_later":
      return [intro, input("date", "Your deadline (optional)", { type: "datepicker" }, true, "Leave empty for no date yet. The requester is told if you set one.")];
    case "set_deadline": {
      const initial = ask.deadline_at ? { initial_date: dateInTz(ask.deadline_at, tz) } : {};
      return [intro, input("date", "Deadline", { type: "datepicker", ...initial }, true, "Clear the date to remove the deadline. The requester is told about changes.")];
    }
    case "done":
      return [intro, textInput("link", "Link (optional)", true, "https://…", false), textInput("note", "Note (optional)", true)];
    case "ack":
      return [intro, textInput("next", "Next step", false, "e.g. I'll send the numbers Thursday")];
    case "reject":
      return [
        intro,
        section(`This goes to <@${ask.requester_id}>, who will see it on their plate. A reason helps them decide what to do next.`),
        textInput("reason", "Reason (optional)", true),
      ];
    case "send_back":
      return [intro, textInput("question", "What do you need to know?", false)];
    case "snooze":
      return [
        intro,
        input("preset", "Remind me", {
          type: "static_select",
          options: [option("In 2 hours", "2h"), option("Tomorrow 9am", "tomorrow"), option("Next Monday 9am", "monday"), option("Custom time…", "custom")],
        }, false, "The ask stays on your plate; only the reminder moves."),
        input("custom", "Custom time (only for “Custom time…”)", { type: "datetimepicker" }, true),
      ];
    case "set_estimate":
      return [
        intro,
        input("size", "Size", {
          type: "static_select",
          options: SIZES.map((s) => option(SIZE_LABEL[s], s)),
          initial_option: option(SIZE_LABEL[ask.size], ask.size),
        }, false),
        input("urgency", "Urgency", {
          type: "static_select",
          options: URGENCIES.map((u) => option(u, u)),
          initial_option: option(ask.urgency, ask.urgency),
        }, false, "Urgency is only a label."),
      ];
    case "redirect":
      return [intro, input("user", "Who should have this?", { type: "users_select" }, false), textInput("note", "Note (optional)", true)];
    case "put_back":
      return [intro, textInput("note", "What should they know?", false, "More detail, an answer, or pushback")];
    case "withdraw":
      return [intro, textInput("note", "Note (optional)", true)];
    default:
      return [intro];
  }
}

export function buildAskModal(kind: AskActionKind, ask: AskRow, meta: ModalMeta, tz: string): Block {
  return {
    type: "modal",
    callback_id: modalCallbackId(kind),
    private_metadata: JSON.stringify(meta),
    title: plain(truncate(ACTION_LABEL[kind], 24)),
    submit: plain(kind === "withdraw" ? "Withdraw" : "Save"),
    close: plain("Cancel"),
    blocks: askBlocks(kind, ask, tz),
  };
}

export interface ParseCtx {
  now: number;
  tz: string;
}

function parseDate(values: ViewValues, ctx: ParseCtx): ParseResult<number | null> {
  const date = val(values, "date")?.selected_date;
  if (!date) return { ok: true, value: null };
  const at = endOfDay(date, ctx.tz);
  if (at === null) return fail("date", "That date isn't valid.");
  if (at <= ctx.now) return fail("date", "Pick a date that isn't in the past.");
  return { ok: true, value: at };
}

function parseSnooze(values: ViewValues, ctx: ParseCtx): ParseResult<number> {
  const preset = val(values, "preset")?.selected_option?.value as SnoozePreset | undefined;
  if (!preset) return fail("preset", "Pick when to be reminded.");
  if (preset === "custom") {
    const at = val(values, "custom")?.selected_date_time;
    if (!at) return fail("custom", "Pick a date and time.");
    const ms = at * 1000;
    return ms > ctx.now ? { ok: true, value: ms } : fail("custom", "Pick a time in the future.");
  }
  if (preset !== "2h" && preset !== "tomorrow" && preset !== "monday") return fail("preset", "Pick when to be reminded.");
  return { ok: true, value: snoozeUntil(preset, ctx.now, ctx.tz) };
}

const optional = (s: string): string | undefined => s || undefined;

export function parseAskSubmission(kind: AskActionKind, values: ViewValues, ctx: ParseCtx): ParseResult<AskAction> {
  switch (kind) {
    case "accept_later": {
      const d = parseDate(values, ctx);
      return d.ok ? { ok: true, value: { kind, deadlineAt: d.value } } : d;
    }
    case "set_deadline": {
      const d = parseDate(values, ctx);
      return d.ok ? { ok: true, value: { kind, deadlineAt: d.value } } : d;
    }
    case "done": {
      const link = str(values, "link");
      if (link && !isHttpUrl(link)) return fail("link", "Enter a full link starting with http:// or https://");
      return { ok: true, value: { kind, link: optional(link), note: optional(str(values, "note")) } };
    }
    case "ack": {
      const nextStep = str(values, "next");
      return nextStep ? { ok: true, value: { kind, nextStep } } : fail("next", "Say what happens next.");
    }
    case "reject":
      return { ok: true, value: { kind, reason: optional(str(values, "reason")) } };
    case "send_back": {
      const question = str(values, "question");
      return question ? { ok: true, value: { kind, question } } : fail("question", "Ask your question.");
    }
    case "snooze": {
      const until = parseSnooze(values, ctx);
      return until.ok ? { ok: true, value: { kind, until: until.value } } : until;
    }
    case "set_estimate": {
      const size = val(values, "size")?.selected_option?.value as Size | undefined;
      const urgency = val(values, "urgency")?.selected_option?.value as Urgency | undefined;
      if (!size || !SIZES.includes(size)) return fail("size", "Pick a size.");
      if (!urgency || !URGENCIES.includes(urgency)) return fail("urgency", "Pick an urgency.");
      return { ok: true, value: { kind, size, urgency } };
    }
    case "redirect": {
      const toUserId = val(values, "user")?.selected_user;
      return toUserId ? { ok: true, value: { kind, toUserId, note: optional(str(values, "note")) } } : fail("user", "Pick a person.");
    }
    case "put_back": {
      const note = str(values, "note");
      return note ? { ok: true, value: { kind, note } } : fail("note", "Add a note so they know what changed.");
    }
    case "withdraw":
      return { ok: true, value: { kind, note: optional(str(values, "note")) } };
    default:
      return fail(FIRST_BLOCK[kind], "That action doesn't take input.");
  }
}

// ---------- request edit modal ----------

const MAX_CHECKBOXES = 10;

export function buildEditModal(req: RequestRow): Block {
  const drafts = parseDrafts(req).slice(0, MAX_CHECKBOXES);
  const options = drafts.map((d, i) => option(truncate(d.title, 70), String(i)));
  const user = (id: string | null) => (id ? { initial_user: id } : {});
  const blocks: Block[] = [
    input("requester", "Who is asking?", { type: "users_select", ...user(req.requester_id) }, false),
    input("owner", "Who is it being asked of?", { type: "users_select", ...user(req.owner_id) }, false),
  ];
  if (options.length > 0) {
    blocks.push(input("items", "Items", { type: "checkboxes", options, initial_options: options }, true, "Uncheck anything that isn't an ask."));
  }
  return {
    type: "modal",
    callback_id: EDIT_CALLBACK_ID,
    private_metadata: JSON.stringify({ requestId: req.id } satisfies EditMeta),
    title: plain("Edit request"),
    submit: plain("Save"),
    close: plain("Cancel"),
    blocks,
  };
}

export interface EditPatch {
  requester_id: string;
  owner_id: string;
  draft_json: string;
}

export function parseEditSubmission(values: ViewValues, req: RequestRow): ParseResult<EditPatch> {
  const requester = val(values, "requester")?.selected_user;
  const owner = val(values, "owner")?.selected_user;
  if (!requester) return fail("requester", "Pick who is asking.");
  if (!owner) return fail("owner", "Pick who it's asked of.");
  if (requester === owner) return fail("owner", "The requester and the owner must be different people.");

  const drafts = parseDrafts(req);
  const shown = Math.min(drafts.length, MAX_CHECKBOXES);
  const checked = new Set((val(values, "items")?.selected_options ?? []).map((o) => Number(o.value)));
  const kept: DraftAsk[] = drafts.filter((_, i) => i >= shown || checked.has(i));
  if (drafts.length > 0 && kept.length === 0) return fail("items", "Keep at least one item, or withdraw by replying in the thread.");
  return { ok: true, value: { requester_id: requester, owner_id: owner, draft_json: JSON.stringify(kept) } };
}
