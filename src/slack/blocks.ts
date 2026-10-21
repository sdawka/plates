// Pure Block Kit renderers: the thread message (confirmation / live request) and DMs.
// No I/O and no cloudflare:workers imports, so these are unit-testable in node.

import { availableActions } from "../domain/transitions";
import { OWNER_PLATE_STATES, type AskRow, type DmTemplate, type DraftAsk, type RequestRow } from "../types";
import { ACTION_LABEL, BUMP_ACTION_ID, REQ_ACTIONS, askActionId, type AskActionKind } from "./actions";
import { dateToken, esc, isHttpUrl, link, mention, plural, sizeUrgency, truncate } from "./format";

export type Block = Record<string, unknown>;
export interface Rendered {
  text: string; // notification / accessibility fallback
  blocks: Block[];
}

/** action_id of the per-ask menu in the thread message. value = `<kind>|<askId>`. */
export const ASK_MENU_ACTION_ID = "ask:overflow";

const mrkdwn = (text: string) => ({ type: "mrkdwn", text });
const plain = (text: string) => ({ type: "plain_text", text, emoji: true });
const section = (text: string, extra: Block = {}): Block => ({ type: "section", text: mrkdwn(truncate(text, 2900)), ...extra });
const context = (text: string): Block => ({ type: "context", elements: [mrkdwn(truncate(text, 2900))] });

function button(kind: AskActionKind, askId: string, label = ACTION_LABEL[kind]): Block {
  const style = kind === "accept_now" || kind === "close" ? { style: "primary" } : {};
  return { type: "button", action_id: askActionId(kind), text: plain(label), value: askId, ...style };
}

const askActions = (ask: AskRow, kinds: AskActionKind[], labels: Partial<Record<AskActionKind, string>> = {}): Block | null =>
  kinds.length === 0
    ? null
    : { type: "actions", block_id: `a:${ask.id}`, elements: kinds.map((k) => button(k, ask.id, labels[k])) };

const compact = (blocks: (Block | null)[]): Block[] => blocks.filter((b): b is Block => b !== null);

// ---------- Thread message ----------

function pendingHeadline(req: RequestRow, drafts: DraftAsk[]): string {
  const n = plural(drafts.length, "thing", "things");
  if (!req.requester_id || !req.owner_id) {
    return `📋 I read ${plural(drafts.length, "possible ask", "possible asks")} here (tagged by ${mention(req.tagged_by_id)})`;
  }
  const tagged = req.tagged_by_id === req.requester_id ? "" : ` (tagged by ${mention(req.tagged_by_id)})`;
  if (req.requester_id === req.owner_id) return `📋 Reminder for *${mention(req.owner_id)}*: ${n}${tagged}`;
  return `📋 *${mention(req.requester_id)}* is asking *${mention(req.owner_id)}* for ${n}${tagged}`;
}

export function parseDrafts(req: RequestRow): DraftAsk[] {
  try {
    const v: unknown = JSON.parse(req.draft_json);
    return Array.isArray(v) ? (v as DraftAsk[]) : [];
  } catch {
    return [];
  }
}

function pendingRequest(req: RequestRow): Rendered {
  const drafts = parseDrafts(req);
  const discarded = req.status === "discarded";
  const headline = pendingHeadline(req, drafts);
  const items = drafts.map((d) => `☐ ${esc(d.title)} · ${sizeUrgency(d)}`).join("\n");
  if (req.status === "dismissed") {
    return {
      text: headline.replace(/[*]/g, ""),
      blocks: [section(`${headline}${items ? `:\n${items}` : ""}`), context("🗑️ Dismissed. Nothing was added to anyone's plate.")],
    };
  }
  const who = req.requester_id && req.owner_id ? `${mention(req.requester_id)} or ${mention(req.owner_id)}` : null;
  const footer = discarded
    ? `This request was not confirmed${who ? `. A ✅ from ${who} still confirms it` : ""}. React ✅ to confirm or just reply to change it.`
    : "React ✅ to confirm or ❌ to change — or just reply.";
  return {
    text: headline.replace(/[*]/g, ""),
    blocks: compact([
      section(`${headline}${items ? `:\n${items}` : ""}`),
      req.clarify_question ? section(`❓ ${esc(req.clarify_question)}`) : null,
      context(footer),
      {
        type: "actions",
        block_id: `r:${req.id}`,
        elements: [
          { type: "button", action_id: REQ_ACTIONS.edit, text: plain("Edit"), value: req.id },
          { type: "button", action_id: REQ_ACTIONS.dismiss, text: plain("Dismiss"), value: req.id },
        ],
      },
    ]),
  };
}

export function askStatusText(ask: AskRow): string {
  const owner = mention(ask.owner_id);
  const requester = mention(ask.requester_id);
  let status: string;
  switch (ask.state) {
    case "proposed": status = `awaiting ${owner}`; break;
    case "in_progress": status = "in progress"; break;
    case "accepted": status = ask.deadline_at ? `accepted · expected ${dateToken(ask.deadline_at)}` : "accepted"; break;
    case "snoozed":
      status = `💤 until ${ask.snoozed_until ? dateToken(ask.snoozed_until) : "later"}${ask.snooze_count > 1 ? ` ×${ask.snooze_count}` : ""}`;
      break;
    case "delivered": status = `delivered — waiting on ${requester} to close`; break;
    case "rejected": status = `rejected — waiting on ${requester}`; break;
    case "clarify": status = `needs info — waiting on ${requester}`; break;
    case "closed": status = "closed"; break;
    case "withdrawn": status = "withdrawn"; break;
  }
  const extras: string[] = [];
  if (ask.state !== "snoozed" && ask.snooze_count > 0) extras.push(`💤×${ask.snooze_count}`);
  if (ask.deadline_change_count > 0) extras.push(`moved ×${ask.deadline_change_count}`);
  if (ask.round_count > 0) extras.push(`round ${ask.round_count + 1}`);
  return [status, ...extras].join(" · ");
}

/** Union of owner and requester actions; the handler / transition enforces who may do what. */
export function menuActions(ask: AskRow): AskActionKind[] {
  const all = [...availableActions(ask, ask.owner_id), ...availableActions(ask, ask.requester_id)];
  return [...new Set(all)];
}

function askMenu(ask: AskRow): Block | null {
  const kinds = menuActions(ask);
  const options = kinds.map((k) => ({ text: plain(ACTION_LABEL[k]), value: `ask:${k}|${ask.id}` }));
  // The requester can nudge an ask that sits on the owner's plate; the handler checks who clicked.
  if (OWNER_PLATE_STATES.includes(ask.state)) options.push({ text: plain("Bump"), value: `${BUMP_ACTION_ID}|${ask.id}` });
  if (options.length === 0) return null;
  return { type: "static_select", action_id: ASK_MENU_ACTION_ID, placeholder: plain("Actions"), options };
}

function askLine(ask: AskRow): string {
  const ended = ask.state === "closed" || ask.state === "withdrawn";
  const title = ended ? `~${esc(ask.title)}~` : esc(ask.title);
  return `${title} · ${sizeUrgency(ask)}\n_${askStatusText(ask)}_`;
}

function liveRequest(req: RequestRow, asks: AskRow[]): Rendered {
  const requester = req.requester_id ? mention(req.requester_id) : "someone";
  const owner = req.owner_id ? mention(req.owner_id) : "someone";
  const headline = `📋 ${requester} → ${owner} · ${plural(asks.length, "ask", "asks")}`;
  return {
    text: `${requester} → ${owner} · ${plural(asks.length, "ask", "asks")}`,
    blocks: [
      section(headline),
      ...asks.map((a): Block => {
        const menu = askMenu(a);
        return { ...section(askLine(a), menu ? { accessory: menu } : {}), block_id: `s:${a.id}` };
      }),
    ],
  };
}

export function renderRequest(req: RequestRow, asks: AskRow[]): Rendered {
  return req.status === "confirmed" ? liveRequest(req, asks) : pendingRequest(req);
}

// ---------- DMs ----------

export interface DmContext {
  req: RequestRow;
  asks: AskRow[]; // all asks in the request
  ask: AskRow | null;
  recipient: string;
  note?: string;
  permalink: string | null;
  /** reminder only: the asks that are due, in the order to list them. */
  reminderAsks?: AskRow[];
  /** action_undone only: who undid it. */
  actor?: string;
  /** deadline_changed only. `from` is undefined when the previous deadline is unknown. */
  deadline?: { from?: number | null; to: number | null };
}

const threadLink = (permalink: string | null, label = "thread") => (permalink ? ` · ${link(permalink, `Open ${label}`)}` : "");
const quote = (s: string) => `> ${esc(s).replace(/\n/g, "\n> ")}`;

function ownerButtons(ask: AskRow, viewer: string): Block | null {
  const wanted: AskActionKind[] = ["accept_now", "accept_later", "done", "ack", "reject", "send_back"];
  return askActions(ask, availableActions(ask, viewer).filter((k) => wanted.includes(k)));
}

/**
 * What replaces an ask's buttons in a DM after `viewer` used one: a line saying what happened and where the ask
 * stands, then the buttons that make sense next (Done after Accept, and so on). Block ids stay `a:<id>`.
 */
export function settledAskBlocks(ask: AskRow, viewer: string, label: string): Block[] {
  const next = viewer === ask.owner_id && OWNER_PLATE_STATES.includes(ask.state)
    ? ownerButtons(ask, viewer)
    : askActions(ask, availableActions(ask, viewer).filter((k) => ["close", "put_back", "redirect"].includes(k)));
  const line = `${label} · now ${askStatusText(ask)}`;
  return compact([{ ...context(line), block_id: `a:${ask.id}:status` }, next]);
}

function requestProposedDm(c: DmContext): Rendered {
  const open = c.asks.filter((a) => a.state === "proposed");
  const head = `📥 *${mention(c.req.requester_id ?? c.req.tagged_by_id)}* asked you for ${plural(open.length, "thing", "things")}${threadLink(c.permalink)}`;
  const blocks = open.flatMap((a): (Block | null)[] => [
    section(
      [`*${esc(a.title)}* · ${sizeUrgency(a)}`, a.detail ? esc(a.detail) : null, a.estimate_reason ? `_${esc(a.estimate_reason)}_` : null,
        a.source_permalink ? link(a.source_permalink, "Source message") : null]
        .filter(Boolean).join("\n"),
    ),
    ownerButtons(a, c.recipient),
  ]);
  return { text: `${mention(c.req.requester_id ?? "someone")} asked you for ${plural(open.length, "thing", "things")}`, blocks: [section(head), ...compact(blocks)] };
}

function deliveredDm(c: DmContext, ask: AskRow): Rendered {
  const detail = [
    ask.next_step ? `Next step: ${esc(ask.next_step)}` : null,
    ask.done_link ? (isHttpUrl(ask.done_link) ? link(ask.done_link, ask.done_link) : esc(ask.done_link)) : null,
    c.note && c.note !== ask.next_step ? quote(c.note) : null,
  ].filter(Boolean).join("\n");
  return {
    text: `${ask.title} was delivered`,
    blocks: compact([
      section(`✅ *${mention(ask.owner_id)}* delivered *${esc(ask.title)}*${threadLink(c.permalink)}${detail ? `\n${detail}` : ""}`),
      askActions(ask, availableActions(ask, c.recipient).filter((k) => k === "close" || k === "put_back")),
    ]),
  };
}

function rejectedDm(c: DmContext, ask: AskRow): Rendered {
  const reason = c.note ? quote(c.note) : "_No reason given._";
  return {
    text: `${ask.title} was rejected`,
    blocks: compact([
      section(`🚫 *${mention(ask.owner_id)}* rejected *${esc(ask.title)}*${threadLink(c.permalink)}\n${reason}`),
      askActions(ask, availableActions(ask, c.recipient).filter((k) => ["put_back", "redirect", "close"].includes(k))),
    ]),
  };
}

function clarifyDm(c: DmContext, ask: AskRow): Rendered {
  return {
    text: `${ask.title}: more info needed`,
    blocks: compact([
      section(`❓ *${mention(ask.owner_id)}* needs more info on *${esc(ask.title)}*${threadLink(c.permalink)}\n${c.note ? quote(c.note) : ""}`),
      askActions(ask, availableActions(ask, c.recipient).filter((k) => ["put_back", "redirect", "close"].includes(k)), {
        put_back: "Put back with answer",
      }),
    ]),
  };
}

function deadlineDm(c: DmContext, ask: AskRow): Rendered {
  const { from, to } = c.deadline ?? { to: ask.deadline_at };
  const who = mention(ask.owner_id);
  const title = `*${esc(ask.title)}*`;
  let line: string;
  if (to === null) line = `${who} removed the deadline on ${title}`;
  else if (typeof from === "number") line = `${who} moved ${title}: ${dateToken(from)} → ${dateToken(to)}`;
  else if (from === undefined && ask.deadline_change_count > 0) line = `${who} moved ${title} to ${dateToken(to)}`;
  else line = `${who} expects ${title} by ${dateToken(to)}`;
  return { text: line.replace(/[*]/g, ""), blocks: [section(`${line}${threadLink(c.permalink)}`)] };
}

function withdrawnDm(c: DmContext, ask: AskRow): Rendered {
  const text = `${mention(ask.requester_id)} withdrew *${esc(ask.title)}* — it's off your plate.`;
  return { text: text.replace(/[*]/g, ""), blocks: [section(`${text}${threadLink(c.permalink)}${c.note ? `\n${quote(c.note)}` : ""}`)] };
}

function askProposedDm(c: DmContext, ask: AskRow): Rendered {
  const head = `📥 *${esc(ask.title)}* is on your plate · ${sizeUrgency(ask)} (asked by ${mention(ask.requester_id)})${threadLink(c.permalink)}`;
  return {
    text: `${ask.title} is on your plate`,
    blocks: compact([section(`${head}${c.note ? `\n${quote(c.note)}` : ""}`), ownerButtons(ask, c.recipient)]),
  };
}

/** The confirmation lives in the tagger's DM with the bot, which nobody else can see: bring it to the people who can confirm. */
function confirmRequestDm(c: DmContext): Rendered {
  const drafts = parseDrafts(c.req);
  const items = drafts.slice(0, 10).map((d) => `☐ ${esc(d.title)} · ${sizeUrgency(d)}`).join("\n");
  const more = drafts.length > 10 ? `\n…and ${drafts.length - 10} more` : "";
  const other = [c.req.requester_id, c.req.owner_id].find((u) => u && u !== c.recipient);
  const source = c.note ? ` from <${c.note}|a DM>` : " from a DM";
  return {
    text: `${mention(c.req.tagged_by_id)} captured an ask from a DM. It needs your confirmation.`,
    blocks: compact([
      section(`${mention(c.req.tagged_by_id)} captured this${source}.\n${pendingHeadline(c.req, drafts)}${items ? `:\n${items}${more}` : ""}`),
      c.req.clarify_question ? section(`❓ ${esc(c.req.clarify_question)}`) : null,
      context(`Only you${other ? ` or ${mention(other)}` : ""} can confirm. Not right? Edit the people or items first.`),
      {
        type: "actions",
        block_id: `r:${c.req.id}`,
        elements: [
          { type: "button", action_id: REQ_ACTIONS.confirm, style: "primary", text: plain("✅ Confirm"), value: c.req.id },
          { type: "button", action_id: REQ_ACTIONS.edit, text: plain("Edit"), value: c.req.id },
          { type: "button", action_id: REQ_ACTIONS.dismiss, text: plain("Dismiss"), value: c.req.id },
        ],
      },
    ]),
  };
}

function nudgeDm(c: DmContext): Rendered {
  const n = plural(parseDrafts(c.req).length, "ask", "asks");
  const who = c.req.requester_id && c.req.owner_id ? `${mention(c.req.requester_id)} → ${mention(c.req.owner_id)}` : "a request";
  return {
    text: "A request is waiting for your confirmation",
    blocks: [
      section(`⏰ Still waiting on a ✅: ${who} · ${n}${threadLink(c.permalink)}\nIf nobody confirms by tomorrow it will be marked unconfirmed.`),
      { type: "actions", block_id: `r:${c.req.id}`, elements: [
        { type: "button", action_id: REQ_ACTIONS.confirm, style: "primary", text: plain("✅ Confirm"), value: c.req.id },
        { type: "button", action_id: REQ_ACTIONS.dismiss, text: plain("Dismiss"), value: c.req.id },
      ] },
    ],
  };
}

// ---------- Phase 2 DMs ----------

/** After this many snoozes the reminder pushes toward a deadline, a redirect or a rejection. */
export const SNOOZE_NUDGE_AT = 3;
const MAX_REMINDER_ASKS = 15; // two blocks each, inside Slack's 50-block message limit

const REMINDER_OWNER_ORDER: AskActionKind[] = ["accept_now", "accept_later", "done", "ack", "set_deadline", "snooze"];
const REQUESTER_PLATE_BUTTONS: AskActionKind[] = ["close", "put_back", "redirect"];

/** Buttons for one ask in a reminder. Pure so the 3-snooze ordering is testable. */
export function reminderButtons(ask: AskRow, viewer: string): { kinds: AskActionKind[]; labels: Partial<Record<AskActionKind, string>> } {
  const available = availableActions(ask, viewer);
  if (ask.holder_id !== viewer || viewer !== ask.owner_id) {
    return { kinds: REQUESTER_PLATE_BUTTONS.filter((k) => available.includes(k)), labels: {} };
  }
  if (ask.snooze_count >= SNOOZE_NUDGE_AT) {
    // A proposed ask has no set_deadline; accept_later asks for the same date.
    const deadline: AskActionKind = available.includes("set_deadline") ? "set_deadline" : "accept_later";
    const kinds = [deadline, "redirect", "reject", "snooze"].filter((k): k is AskActionKind => available.includes(k as AskActionKind));
    return { kinds, labels: { accept_later: "Set deadline", snooze: "Snooze anyway" } };
  }
  const kinds = REMINDER_OWNER_ORDER.filter((k) => available.includes(k));
  if (ask.state === "proposed" && available.includes("reject")) kinds.push("reject");
  return { kinds, labels: {} };
}

function reminderItem(ask: AskRow, viewer: string): Block[] {
  const onOwner = ask.holder_id === ask.owner_id;
  const who = onOwner ? `from ${mention(ask.requester_id)}` : `${mention(ask.owner_id)} · ${askStatusText(ask)}`;
  const meta = [who, sizeUrgency(ask)];
  if (ask.deadline_at !== null) meta.push(`due ${dateToken(ask.deadline_at)}`);
  if (ask.snooze_count > 0) meta.push(`💤×${ask.snooze_count}`);
  const nudge = onOwner && ask.snooze_count >= SNOOZE_NUDGE_AT
    ? `\n_Snoozed ${ask.snooze_count} times. Pick a deadline, hand it off, or say no?_`
    : "";
  const { kinds, labels } = reminderButtons(ask, viewer);
  return compact([
    section(`*${esc(ask.title)}*\n${meta.join(" · ")}${nudge}`),
    askActions(ask, kinds, labels),
  ]);
}

function reminderDm(c: DmContext): Rendered | null {
  const asks = (c.reminderAsks ?? []).filter((a) => a.state !== "closed" && a.state !== "withdrawn");
  if (asks.length === 0) return null;
  const shown = asks.slice(0, MAX_REMINDER_ASKS);
  const head = `⏰ *Reminder:* ${plural(asks.length, "ask is", "asks are")} waiting on you`;
  return {
    text: `Reminder: ${plural(asks.length, "ask is", "asks are")} waiting on you`,
    blocks: [
      section(head),
      ...shown.flatMap((a) => reminderItem(a, c.recipient)),
      ...(asks.length > shown.length ? [context(`…and ${asks.length - shown.length} more on your Home tab.`)] : []),
    ],
  };
}

function bumpDm(c: DmContext, ask: AskRow): Rendered {
  const { kinds, labels } = reminderButtons(ask, c.recipient);
  return {
    text: `${ask.title}: bumped`,
    blocks: compact([
      section(`👋 ${mention(ask.requester_id)} bumped *${esc(ask.title)}*${threadLink(c.permalink)}\n${askStatusText(ask)}`),
      askActions(ask, kinds, labels),
    ]),
  };
}

function undoneDm(c: DmContext, ask: AskRow): Rendered {
  const label = c.note && c.note in ACTION_LABEL ? ACTION_LABEL[c.note as AskActionKind] : null;
  const what = label ? `*${label}*` : "their last action";
  const text = `${c.actor ? mention(c.actor) : "Someone"} undid ${what} on *${esc(ask.title)}*`;
  return { text: text.replace(/[*]/g, ""), blocks: [section(`↩︎ ${text}${threadLink(c.permalink)}`)] };
}

/** Returns null when the template needs an ask and there isn't one. */
export function renderDm(template: DmTemplate, c: DmContext): Rendered | null {
  if (template === "request_proposed") return requestProposedDm(c);
  if (template === "confirm_nudge") return nudgeDm(c);
  if (template === "confirm_request") return confirmRequestDm(c);
  if (template === "reminder") return reminderDm(c);
  const ask = c.ask;
  if (!ask) return null;
  switch (template) {
    case "ask_delivered": return deliveredDm(c, ask);
    case "ask_rejected": return rejectedDm(c, ask);
    case "ask_clarify": return clarifyDm(c, ask);
    case "deadline_changed": return deadlineDm(c, ask);
    case "ask_withdrawn": return withdrawnDm(c, ask);
    case "ask_proposed": return askProposedDm(c, ask);
    case "bump": return bumpDm(c, ask);
    case "action_undone": return undoneDm(c, ask);
  }
}
