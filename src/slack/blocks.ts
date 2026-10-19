// Pure Block Kit renderers: the thread message (confirmation / live request) and DMs.
// No I/O and no cloudflare:workers imports, so these are unit-testable in node.

import { availableActions } from "../domain/transitions";
import type { AskRow, DmTemplate, DraftAsk, RequestRow } from "../types";
import { ACTION_LABEL, REQ_ACTIONS, askActionId, type AskActionKind } from "./actions";
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
      { type: "actions", block_id: `r:${req.id}`, elements: [{ type: "button", action_id: REQ_ACTIONS.edit, text: plain("Edit"), value: req.id }] },
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
  if (kinds.length === 0) return null;
  return {
    type: "static_select",
    action_id: ASK_MENU_ACTION_ID,
    placeholder: plain("Actions"),
    options: kinds.map((k) => ({ text: plain(ACTION_LABEL[k]), value: `ask:${k}|${ask.id}` })),
  };
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
  /** deadline_changed only. `from` is undefined when the previous deadline is unknown. */
  deadline?: { from?: number | null; to: number | null };
}

const threadLink = (permalink: string | null, label = "thread") => (permalink ? ` · ${link(permalink, `Open ${label}`)}` : "");
const quote = (s: string) => `> ${esc(s).replace(/\n/g, "\n> ")}`;

function ownerButtons(ask: AskRow, viewer: string): Block | null {
  const wanted: AskActionKind[] = ["accept_now", "accept_later", "done", "ack", "reject", "send_back"];
  return askActions(ask, availableActions(ask, viewer).filter((k) => wanted.includes(k)));
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

function nudgeDm(c: DmContext): Rendered {
  const n = plural(parseDrafts(c.req).length, "ask", "asks");
  const who = c.req.requester_id && c.req.owner_id ? `${mention(c.req.requester_id)} → ${mention(c.req.owner_id)}` : "a request";
  return {
    text: "A request is waiting for your confirmation",
    blocks: [
      section(`⏰ Still waiting on a ✅: ${who} · ${n}${threadLink(c.permalink)}\nIf nobody confirms by tomorrow it will be marked unconfirmed.`),
      { type: "actions", block_id: `r:${c.req.id}`, elements: [{ type: "button", action_id: REQ_ACTIONS.confirm, style: "primary", text: plain("✅ Confirm"), value: c.req.id }] },
    ],
  };
}

/** Returns null when the template needs an ask and there isn't one. */
export function renderDm(template: DmTemplate, c: DmContext): Rendered | null {
  if (template === "request_proposed") return requestProposedDm(c);
  if (template === "confirm_nudge") return nudgeDm(c);
  const ask = c.ask;
  if (!ask) return null;
  switch (template) {
    case "ask_delivered": return deliveredDm(c, ask);
    case "ask_rejected": return rejectedDm(c, ask);
    case "ask_clarify": return clarifyDm(c, ask);
    case "deadline_changed": return deadlineDm(c, ask);
    case "ask_withdrawn": return withdrawnDm(c, ask);
    case "ask_proposed": return askProposedDm(c, ask);
    case "reminder":
    case "bump":
    case "action_undone":
      return null; // Phase 2: rendered by the conversational agent
  }
}
