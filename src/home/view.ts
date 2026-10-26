// Pure Home tab renderer: data in, Block Kit view out. No I/O, no Workers imports.

import { OWNER_PLATE_STATES, SIZE_LABEL, type AskRow, type AskState, type DraftAsk, type RequestRow, type Size, type Urgency } from "../types";
import { isHttpUrl } from "../slack/format";
import { dmAccessBlocks, type DmAccess } from "../slack/dmaccess";
import { helpButton } from "../slack/help";
import { BUMP_INTERVAL_MS } from "../domain/service";
import { BUMP_ACTION_ID, HOME_REFRESH_ACTION_ID, REQ_ACTIONS, SETTINGS_OPEN_ACTION_ID } from "../slack/actions";
import { actionsBlock } from "../slack/buttons";

export type Block = Record<string, unknown>;
export interface View {
  type: "home";
  blocks: Block[];
}

export interface HomeData {
  plate: AskRow[]; // asks the viewer holds
  waiting: AskRow[]; // asks the viewer made, held by someone else
  unconfirmed: RequestRow[];
  dm?: DmAccess; // DM access row; omitted in tests / when unknown
}

export const MAX_BLOCKS = 100;
const BUDGET = { response: 28, plate: 32, waiting: 18, unconfirmed: 12 } as const;
const TEXT_MAX = 3000;
const SIZE_ORDER: Size[] = ["days", "hours", "lt1h", "2-5min"];

// ---------- Text helpers ----------

export const clamp = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const user = (id: string | null): string => (id ? `<@${id}>` : "someone");
const mrkdwn = (text: string) => ({ type: "mrkdwn", text: clamp(text, TEXT_MAX) });
const section = (text: string, blockId?: string): Block => ({ type: "section", ...(blockId ? { block_id: blockId } : {}), text: mrkdwn(text) });
const context = (text: string): Block => ({ type: "context", elements: [mrkdwn(text)] });
const header = (text: string): Block => ({ type: "header", text: { type: "plain_text", text: clamp(text, 150), emoji: true } });
const divider = (): Block => ({ type: "divider" });
const quote = (s: string): string => `> ${esc(clamp(s, 600)).replace(/\n/g, "\n> ")}`;
const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export function dateToken(ms: number, format = "{date_short_pretty}"): string {
  return `<!date^${Math.floor(ms / 1000)}^${format}|${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC>`;
}

export function formatAge(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  if (mins < 60) return `${Math.max(mins, 1)}m`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** "due <date>", flagged when the deadline has passed. */
function dueText(deadlineAt: number, now: number): string {
  return deadlineAt < now ? `⚠️ overdue · was due ${dateToken(deadlineAt)}` : `due ${dateToken(deadlineAt)}`;
}

/** Open work by size, e.g. "1 × few hours · 2 × <1 hr". Empty string when the plate is empty. */
export function sizeSummary(plate: AskRow[]): string {
  const parts = SIZE_ORDER.flatMap((size) => {
    const count = plate.filter((a) => a.size === size).length;
    return count > 0 ? [`${count} × ${SIZE_LABEL[size]}`] : [];
  });
  return esc(parts.join(" · "));
}

function summaryLine(plate: AskRow[]): string {
  if (plate.length === 0) return "Nothing on your plate right now.";
  return `*On your plate:* ${sizeSummary(plate)}`;
}

// ---------- Ask cards ----------

const URGENCY_TEXT: Record<Urgency, string | null> = { low: "low urgency", normal: null, high: "⬆️ high urgency", urgent: "🔥 urgent" };

function metaParts(ask: AskRow, now: number): string[] {
  const parts = [SIZE_LABEL[ask.size]];
  const urgency = URGENCY_TEXT[ask.urgency];
  if (urgency) parts.push(urgency);
  if (ask.deadline_at !== null) parts.push(dueText(ask.deadline_at, now));
  if (ask.deadline_change_count > 0) parts.push(`moved ×${ask.deadline_change_count}`);
  if (ask.snooze_count > 0) parts.push(`💤×${ask.snooze_count}`);
  if (ask.round_count > 0) parts.push(`round ${ask.round_count + 1}`);
  return parts;
}

/** Source message and, when the ask is mirrored to Jira / Linear, the ticket ("jira:PROJ-12" → PROJ-12). */
const sourceLink = (ask: AskRow): string | null => {
  const parts = [
    ask.source_permalink ? `<${ask.source_permalink}|source message>` : null,
    ask.tracker_url ? `<${ask.tracker_url}|${esc(ask.tracker_ref?.split(":").slice(1).join(":") || "ticket")}>` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
};

interface Unit {
  blocks: Block[];
  group?: { key: string; block: Block };
}

function responseText(ask: AskRow, now: number): string {
  const title = `*${esc(clamp(ask.title, 300))}*`;
  const who = user(ask.owner_id);
  const meta = metaParts(ask, now).join(" · ");
  switch (ask.state) {
    case "proposed":
      return `📥 ${title}\n${user(ask.requester_id)} asked you · ${meta}`;
    case "delivered":
      return `📦 ${title}\n${who} says it's done · ${meta}${ask.done_link ? `\n${isHttpUrl(ask.done_link) ? `<${ask.done_link}|Open the result>` : esc(ask.done_link)}` : ""}`;
    case "rejected":
      return `🚫 ${title}\n${who} turned this down · ${meta}`;
    default:
      return `❓ ${title}\n${who} needs more info · ${meta}`;
  }
}

function responseUnit(ask: AskRow, viewer: string, now: number, withActions = true): Unit {
  const blocks: Block[] = [section(responseText(ask, now), `resp:${ask.id}`)];
  if (ask.last_note) blocks.push(context(quote(ask.last_note)));
  const link = sourceLink(ask);
  if (link) blocks.push(context(link));
  const actions = withActions ? actionsBlock(ask, viewer, `resp_actions:${ask.id}`) : null;
  if (actions) blocks.push(actions);
  return { blocks };
}

function plateUnit(ask: AskRow, viewer: string, now: number, withActions = true): Unit {
  const snoozed = ask.state === "snoozed";
  const title = esc(clamp(ask.title, 300));
  const lines: string[] = [snoozed ? `💤 ~${title}~` : `*${title}*`];
  const meta = metaParts(ask, now).filter((p) => !(snoozed && p.startsWith("💤")));
  if (ask.state === "in_progress") meta.unshift("🔧 in progress");
  lines.push(meta.join(" · "));
  if (snoozed && ask.snoozed_until !== null) {
    const wake = ask.snoozed_until <= now ? "waking up" : `wakes ${dateToken(ask.snoozed_until, "{date_short_pretty} {time}")}`;
    lines.push(`${wake} · 💤×${ask.snooze_count}`);
  }
  const link = sourceLink(ask);
  if (link) lines.push(link);
  const blocks: Block[] = [section(lines.join("\n"), `plate:${ask.id}`)];
  const actions = withActions ? actionsBlock(ask, viewer, `plate_actions:${ask.id}`) : null;
  if (actions) blocks.push(actions);
  return {
    blocks,
    group: { key: ask.requester_id, block: context(`From ${user(ask.requester_id)}`) },
  };
}

const STATE_WORDS: Record<AskState, string> = {
  proposed: "hasn't responded yet",
  accepted: "accepted it",
  in_progress: "is working on it",
  snoozed: "snoozed it",
  delivered: "delivered it",
  rejected: "rejected it",
  clarify: "needs more info",
  closed: "closed",
  withdrawn: "withdrawn",
};

function waitingUnit(ask: AskRow, viewer: string, now: number, withActions = true): Unit {
  const lines = [`*${esc(clamp(ask.title, 300))}*`];
  const parts = [`${user(ask.holder_id)} ${STATE_WORDS[ask.state]}`, SIZE_LABEL[ask.size]];
  if (ask.deadline_at !== null) parts.push(dueText(ask.deadline_at, now));
  if (ask.deadline_change_count > 0) parts.push(`moved ×${ask.deadline_change_count}`);
  lines.push(parts.join(" · "));
  const extra = [`asked ${formatAge(now - ask.created_at)} ago`, `last activity ${formatAge(now - ask.updated_at)} ago`];
  // Only asks sitting on the owner's plate can be bumped, once a day.
  const bumpable = OWNER_PLATE_STATES.includes(ask.state) && viewer === ask.requester_id;
  const bumpedRecently = ask.last_bumped_at !== null && now - ask.last_bumped_at < BUMP_INTERVAL_MS;
  if (bumpable && bumpedRecently) extra.push("bumped today");
  const link = sourceLink(ask);
  if (link) extra.push(link);
  const blocks: Block[] = [section(lines.join("\n"), `wait:${ask.id}`), context(extra.join(" · "))];
  const actions = withActions ? actionsBlock(ask, viewer, `wait_actions:${ask.id}`) : null;
  if (withActions && bumpable && !bumpedRecently) {
    const bump = {
      type: "button",
      action_id: BUMP_ACTION_ID,
      text: { type: "plain_text", text: "👋 Bump", emoji: true },
      value: ask.id,
    };
    if (actions) (actions.elements as Block[]).unshift(bump);
    else blocks.push({ type: "actions", block_id: `wait_actions:${ask.id}`, elements: [bump] });
  }
  if (actions) blocks.push(actions);
  return { blocks };
}

// ---------- Unconfirmed requests ----------

function draftTitles(req: RequestRow): string[] {
  try {
    const drafts = JSON.parse(req.draft_json) as Partial<DraftAsk>[];
    return drafts.flatMap((d) => (typeof d.title === "string" ? [d.title] : []));
  } catch {
    return [];
  }
}

function unconfirmedUnit(req: RequestRow, viewer: string): Unit {
  const titles = draftTitles(req);
  const items = titles.length > 0 ? titles.map((t) => `• ${esc(clamp(t, 200))}`).join("\n") : "• (no items extracted)";
  const status = req.status === "discarded" ? "⌛ Nobody confirmed this in time" : "⏳ Waiting for a confirmation";
  const people = `${user(req.requester_id)} asking ${user(req.owner_id)}`;
  const blocks: Block[] = [section(`${status} · ${people}\n${items}`, `unconf:${req.id}`)];
  const elements: Block[] = [];
  if (viewer === req.requester_id || viewer === req.owner_id) {
    elements.push({
      type: "button",
      action_id: REQ_ACTIONS.confirm,
      text: { type: "plain_text", text: "✅ Confirm", emoji: true },
      style: "primary",
      value: req.id,
    });
  }
  if (viewer === req.requester_id || viewer === req.owner_id || viewer === req.tagged_by_id) {
    elements.push({
      type: "button",
      action_id: REQ_ACTIONS.dismiss,
      text: { type: "plain_text", text: "Dismiss", emoji: true },
      value: req.id,
      confirm: {
        title: { type: "plain_text", text: "Dismiss this request?" },
        text: { type: "plain_text", text: "It leaves everyone's Home and nothing goes on a plate." },
        confirm: { type: "plain_text", text: "Dismiss" },
        deny: { type: "plain_text", text: "Keep" },
      },
    });
  }
  elements.push({
    type: "button",
    action_id: REQ_ACTIONS.openThread,
    text: { type: "plain_text", text: "Open thread", emoji: true },
    url: `https://slack.com/app_redirect?channel=${encodeURIComponent(req.channel_id)}&message_ts=${encodeURIComponent(req.thread_ts)}`,
  });
  blocks.push({ type: "actions", block_id: `unconf_actions:${req.id}`, elements });
  return { blocks };
}

// ---------- Sections and budget ----------

/** Pack units into `budget` blocks, adding group headers and an "…and N more" line on truncation. */
export function fit(units: Unit[], budget: number): Block[] {
  const out: Block[] = [];
  let lastGroup: string | undefined;
  for (const [i, unit] of units.entries()) {
    const newGroup = unit.group !== undefined && unit.group.key !== lastGroup;
    const cost = unit.blocks.length + (newGroup ? 1 : 0);
    const remaining = units.length - i - 1;
    if (out.length + cost + (remaining > 0 ? 1 : 0) > budget) {
      out.push(context(`…and ${units.length - i} more`));
      return out;
    }
    if (newGroup && unit.group) out.push(unit.group.block);
    lastGroup = unit.group?.key ?? lastGroup;
    out.push(...unit.blocks);
  }
  return out;
}

/** A titled section with its count; `empty` text when there is nothing, or nothing at all when `empty` is null. */
function renderSection(title: string, units: Unit[], empty: string | null, budget: number): Block[] {
  if (units.length === 0) return empty === null ? [] : [header(title), context(empty)];
  return [header(`${title} (${units.length})`), ...fit(units, budget - 1)];
}

const byAsc = (a: number | null, b: number | null) => (a ?? 0) - (b ?? 0);

function plateRank(a: AskRow): number {
  if (a.state === "in_progress") return 0;
  if (a.state === "accepted") return a.deadline_at !== null ? 1 : 2;
  return 3;
}

export function sortPlate(asks: AskRow[]): AskRow[] {
  return [...asks].sort((a, b) => {
    const rank = plateRank(a) - plateRank(b);
    if (rank !== 0) return rank;
    if (a.state === "snoozed") return byAsc(a.snoozed_until, b.snoozed_until) || a.created_at - b.created_at;
    if (a.deadline_at !== null && b.deadline_at !== null) return a.deadline_at - b.deadline_at;
    return a.created_at - b.created_at;
  });
}

/** Stable grouping by requester, groups ordered by their most urgent ask. */
function groupByRequester(sorted: AskRow[]): AskRow[] {
  const groups = new Map<string, AskRow[]>();
  for (const ask of sorted) groups.set(ask.requester_id, [...(groups.get(ask.requester_id) ?? []), ask]);
  return [...groups.values()].flat();
}

const NEEDS_RESPONSE: AskState[] = ["proposed", "delivered", "rejected", "clarify"];
const ON_PLATE: AskState[] = ["in_progress", "accepted", "snoozed"];

/** The one-line status at the top: what needs you, what you hold, what you wait on. */
export function headline(needs: number, onPlate: number, waiting: number, overdue: number): string {
  if (needs + onPlate + waiting === 0) return "Your plate is clear. 🎉";
  const parts = [
    needs > 0 ? `*${n(needs, "ask")} need${needs === 1 ? "s" : ""} your response*` : null,
    `${n(onPlate, "ask")} on your plate${overdue > 0 ? ` (⚠️ ${n(overdue, "overdue")})` : ""}`,
    waiting > 0 ? `waiting on ${n(waiting, "ask")} from others` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

const GETTING_STARTED = [
  "*To put something on someone's plate:*",
  "• Tag *@plates* in a thread where you asked for something. I read it and draft the ask.",
  "• On any message: ⋯ → *Put on someone's plate*.",
  "• `/plates @bob send the Q3 deck by Friday`, or just DM me the ask.",
  "The person asking or the person doing it confirms, and it shows up here.",
].join("\n");

export function buildHomeView(data: HomeData, viewerId: string, now: number): View {
  const needs = data.plate.filter((a) => NEEDS_RESPONSE.includes(a.state));
  const onPlate = groupByRequester(sortPlate(data.plate.filter((a) => ON_PLATE.includes(a.state))));
  const overdue = onPlate.filter((a) => a.deadline_at !== null && a.deadline_at < now).length;
  const nothing = needs.length + onPlate.length + data.waiting.length + data.unconfirmed.length === 0;
  const blocks: Block[] = [
    header("Your plate"),
    section(headline(needs.length, onPlate.length, data.waiting.length, overdue)),
    ...(onPlate.length > 0 ? [context(`Open work: ${sizeSummary(onPlate)}`)] : []),
    {
      type: "actions",
      block_id: "home_settings",
      elements: [
        { type: "button", action_id: HOME_REFRESH_ACTION_ID, text: { type: "plain_text", text: "↻ Refresh", emoji: true }, value: "refresh" },
        { type: "button", action_id: SETTINGS_OPEN_ACTION_ID, text: { type: "plain_text", text: "⚙ Settings", emoji: true }, value: "open" },
        helpButton(),
      ],
    },
    context(`Updated ${dateToken(now, "{date_short_pretty} {time}")}`),
  ];
  if (nothing) {
    blocks.push(divider(), section(GETTING_STARTED));
  } else {
    blocks.push(
      ...renderSection("Needs your response", needs.map((a) => responseUnit(a, viewerId, now)), null, BUDGET.response),
      ...renderSection("On your plate", onPlate.map((a) => plateUnit(a, viewerId, now)), "Nothing in progress. Asks you accept land here.", BUDGET.plate),
      ...renderSection("Waiting on others", data.waiting.map((a) => waitingUnit(a, viewerId, now)), "You aren't waiting on anyone.", BUDGET.waiting),
      ...renderSection("Unconfirmed", data.unconfirmed.map((r) => unconfirmedUnit(r, viewerId)), null, BUDGET.unconfirmed),
    );
  }
  blocks.push(...dmAccessBlocks(data.dm));
  return { type: "home", blocks: blocks.slice(0, MAX_BLOCKS) };
}

/** Messages allow 50 blocks; leave room for the header and the closing hint. */
const MESSAGE_BUDGET = 46;
const ACT_HINT = "To act on these, open my *Home* tab, or reply in the ask's thread.";

/**
 * A read-only answer to "what's on my plate?" or "what am I waiting on?" in a DM. No buttons: a list in a
 * message goes stale, and the Home tab is where asks are worked.
 */
export function buildPlateMessage(data: HomeData, viewerId: string, now: number, which: "plate" | "waiting"): { text: string; blocks: Block[] } {
  if (which === "waiting") {
    const units = data.waiting.map((a) => waitingUnit(a, viewerId, now, false));
    const text = units.length === 0 ? "You aren't waiting on anyone." : `You're waiting on ${units.length === 1 ? "1 ask" : `${units.length} asks`}.`;
    const blocks = units.length === 0 ? [section(text)] : [section(`*${text}*`), ...fit(units, MESSAGE_BUDGET), context(ACT_HINT)];
    return { text, blocks };
  }
  const needs = data.plate.filter((a) => NEEDS_RESPONSE.includes(a.state));
  const onPlate = groupByRequester(sortPlate(data.plate.filter((a) => ON_PLATE.includes(a.state))));
  if (needs.length === 0 && onPlate.length === 0) {
    const text = "Your plate is clear. 🎉";
    return { text, blocks: [section(text)] };
  }
  const text = summaryLine(data.plate).replace(/[*]/g, "");
  const half = needs.length && onPlate.length ? Math.floor(MESSAGE_BUDGET / 2) : MESSAGE_BUDGET;
  const blocks: Block[] = [section(summaryLine(data.plate))];
  if (needs.length) blocks.push(section("*Needs your response*"), ...fit(needs.map((a) => responseUnit(a, viewerId, now, false)), half - 1));
  if (onPlate.length) blocks.push(section("*On your plate*"), ...fit(onPlate.map((a) => plateUnit(a, viewerId, now, false)), half - 1));
  blocks.push(context(ACT_HINT));
  return { text, blocks };
}
