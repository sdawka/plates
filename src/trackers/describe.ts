// Pure helpers: issue description and the plan of tracker operations for an ask's state change.

import { SIZE_LABEL, type AskRow, type AskState } from "../types";

export interface Paragraph {
  text: string;
  href?: string;
}

/** What the tracker last saw for an ask (row in tracker_sync). */
export interface SyncState {
  state: AskState | null;
  deadline_at: number | null;
  owner_id: string | null;
}

export type StatusKind = "todo" | "doing" | "done" | "cancel";

export type Step =
  | { op: "due"; date: string | null; patch: Partial<SyncState> }
  | { op: "assign"; patch: Partial<SyncState> }
  | { op: "status"; to: StatusKind; fallbackComment?: string; patch: Partial<SyncState> }
  | { op: "comment"; text: string; patch: Partial<SyncState> }
  | { op: "record"; patch: Partial<SyncState> }; // nothing to tell the tracker, just remember the state

export interface People {
  requester: string;
  owner: string;
  /** Owner could not be mapped to a tracker user. */
  ownerUnmapped?: boolean;
  /** Owner's IANA timezone: deadlines are calendar dates there. */
  ownerTz?: string | null;
}

/** Calendar date of an instant in `tz` (IANA name); UTC when tz is missing or invalid. */
export function isoDate(ms: number, tz?: string | null): string {
  if (tz) {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
    } catch {
      // fall through to UTC
    }
  }
  return new Date(ms).toISOString().slice(0, 10);
}

const REQUESTER_PLATE: AskState[] = ["delivered", "rejected", "clarify"];

export function buildDescription(ask: AskRow, who: People): Paragraph[] {
  const out: Paragraph[] = [];
  if (ask.detail) out.push({ text: ask.detail });
  out.push({ text: `Requester: ${who.requester}` });
  out.push({ text: `Owner: ${who.owner}${who.ownerUnmapped ? " (no matching tracker user, left unassigned)" : ""}` });
  out.push({ text: `Size: ${SIZE_LABEL[ask.size]} | Urgency: ${ask.urgency}` });
  if (ask.estimate_reason) out.push({ text: `Estimate reason: ${ask.estimate_reason}` });
  if (ask.deadline_at != null) out.push({ text: `Deadline: ${isoDate(ask.deadline_at, who.ownerTz)}` });
  if (ask.source_permalink) out.push({ text: "Slack source", href: ask.source_permalink });
  return out;
}

export const toMarkdown = (ps: Paragraph[]): string =>
  ps.map((p) => (p.href ? `[${p.text}](${p.href})` : p.text)).join("\n\n");

export const toPlain = (ps: Paragraph[]): string => ps.map((p) => (p.href ? `${p.text}: ${p.href}` : p.text)).join("\n\n");

/**
 * Operations needed to bring the tracker from `prev` to the ask's current state. Every step carries
 * the patch to record once it succeeded, so a failure part-way resumes at the failed step.
 * An empty plan means the tracker is already up to date.
 */
export function planSync(ask: AskRow, prev: SyncState, who: People): Step[] {
  const steps: Step[] = [];

  if (ask.deadline_at !== prev.deadline_at) {
    steps.push({
      op: "due",
      date: ask.deadline_at == null ? null : isoDate(ask.deadline_at, who.ownerTz),
      patch: { deadline_at: ask.deadline_at },
    });
  }

  if (ask.owner_id !== prev.owner_id) {
    steps.push({ op: "assign", patch: { owner_id: ask.owner_id } });
    if (prev.owner_id != null) {
      steps.push({ op: "comment", text: `Reassigned to ${who.owner}.`, patch: {} });
    }
  }

  const from = prev.state;
  const to = ask.state;
  if (to !== from) {
    const note = ask.last_note?.trim();
    const patch = { state: to };
    switch (to) {
      case "in_progress":
        steps.push(...putBack(from, ask, who));
        steps.push({ op: "status", to: "doing", patch });
        break;
      case "proposed":
      case "accepted":
        steps.push(...putBack(from, ask, who));
        if (from != null && from !== "snoozed" && from !== "proposed" && from !== "accepted") {
          steps.push({ op: "status", to: "todo", patch });
        } else steps.push({ op: "record", patch });
        break;
      case "snoozed":
        steps.push({ op: "record", patch });
        break;
      case "delivered": {
        const parts = [`Delivered by ${who.owner}.`];
        if (ask.last_note) parts.push(ask.last_note);
        if (ask.done_link) parts.push(ask.done_link);
        steps.push({ op: "comment", text: parts.join("\n"), patch });
        break;
      }
      case "rejected":
        steps.push({ op: "comment", text: `Rejected by ${who.owner}${note ? `: ${note}` : "."}`, patch });
        break;
      case "clarify":
        steps.push({ op: "comment", text: `${who.owner} needs clarification${note ? `: ${note}` : "."}`, patch });
        break;
      case "closed":
        steps.push({ op: "status", to: "done", patch });
        break;
      case "withdrawn":
        steps.push({
          op: "status",
          to: "cancel",
          fallbackComment: `Withdrawn by ${who.requester}${note ? `: ${note}` : "."}`,
          patch,
        });
        break;
    }
  }
  return steps;
}

function putBack(from: AskState | null, ask: AskRow, who: People): Step[] {
  if (from == null || !REQUESTER_PLATE.includes(from)) return [];
  const note = ask.last_note?.trim();
  return [{ op: "comment", text: `Put back by ${who.requester}${note ? `: ${note}` : "."}`, patch: {} }];
}
