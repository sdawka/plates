// Pure validation of the intent decision. Nothing here touches I/O: System One picks among the options
// built from the state machine, this decides whether the pick is applied, proposed or ignored and which
// values the action carries.

import { parseDue } from "../extract/dates";
import { availableActions } from "../domain/transitions";
import { JEV_THRESHOLDS, type Thresholds } from "../thresholds";
import type { AskAction, AskRow } from "../types";

export const INTENT_KINDS = [
  "accept_now", "accept_later", "done", "ack", "reject", "send_back", "set_deadline", "redirect", "close", "put_back", "withdraw",
] as const satisfies readonly AskAction["kind"][];
export type IntentKind = (typeof INTENT_KINDS)[number];

// The Jev defaults, for tests and docs. At runtime the thresholds come from `ValidateInput.thresholds`
// (see src/thresholds.ts), so a different DECIDE_MODEL can carry its own.
export const AUTO_P = JEV_THRESHOLDS.AUTO_P;
export const PROPOSE_P = JEV_THRESHOLDS.PROPOSE_P;
export const AMBIGUOUS_P = JEV_THRESHOLDS.AMBIGUOUS_P;
export const DELIVERS_P = JEV_THRESHOLDS.DELIVERS_P;
export const DEADLINE_P = JEV_THRESHOLDS.DEADLINE_P;
const MAX_NOTE = 500;

const isIntentKind = (v: unknown): v is IntentKind => typeof v === "string" && (INTENT_KINDS as readonly string[]).includes(v);

export interface Candidate {
  ref: string; // short handle used in option keys ("A1")
  ask: AskRow;
  role: "owner" | "requester";
  allowed: IntentKind[];
}

/** The open asks the speaker is a party to, with what they may do to each. */
export function buildCandidates(asks: AskRow[], speaker: string): Candidate[] {
  const out: Candidate[] = [];
  for (const ask of asks) {
    if (ask.state === "closed" || ask.state === "withdrawn") continue;
    if (speaker !== ask.owner_id && speaker !== ask.requester_id) continue;
    const allowed = availableActions(ask, speaker).filter(isIntentKind);
    out.push({ ref: `A${out.length + 1}`, ask, role: speaker === ask.owner_id ? "owner" : "requester", allowed });
  }
  return out;
}

export interface Shared {
  links: string[];
  files: { name: string | null; permalink: string | null }[];
}

export interface IntentDecision {
  /** "none", or "<ref>:<action>" for one of the candidates' allowed actions. */
  choice: string;
  /** Probability of `choice`. */
  p: number;
  /** Probability that the reply could apply to more than one open ask. */
  ambiguous: number;
  /** Local date (YYYY-MM-DD) the reply names, null for none or an unsure answer. */
  deadline: string | null;
  /** Per candidate ref: probability that the shared file or link delivers it. */
  delivers: Record<string, number>;
}

export interface ValidateInput extends Shared {
  decision: IntentDecision;
  candidates: Candidate[];
  speaker: string;
  /** The speaker's reply; becomes the note the action carries. */
  text: string;
  tz: string;
  now: number;
  /** The bot's own user id, never a redirect target. */
  botUserId?: string;
  /** Gates for the decision model that answered; the Jev defaults when absent. */
  thresholds?: Thresholds;
}

export type Outcome =
  | { kind: "none" }
  | {
      kind: "act";
      action: AskAction;
      /** Chosen ask, or null when the speaker should pick. */
      askId: string | null;
      /** Asks this action could apply to (for the "Pick ask" menu). */
      eligible: Candidate[];
      /** Probability of the chosen action. */
      confidence: number;
      /** Sure and unambiguous: apply now and offer Undo. */
      auto: boolean;
    };

const clean = (v: string): string | undefined => v.trim().slice(0, MAX_NOTE) || undefined;

/** "A1:accept_now" -> its candidate and action; null for "none" or anything not on offer. */
export function parseChoice(candidates: Candidate[], choice: string): { candidate: Candidate; kind: IntentKind } | null {
  const i = choice.indexOf(":");
  if (i < 0) return null;
  const candidate = candidates.find((c) => c.ref === choice.slice(0, i));
  const kind = choice.slice(i + 1);
  return candidate && isIntentKind(kind) && candidate.allowed.includes(kind) ? { candidate, kind } : null;
}

/** First `<@U…>` mention in the reply that isn't the speaker or the bot. */
export function mentionedUser(text: string, speaker: string, botUserId?: string): string | null {
  for (const m of text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)) {
    if (m[1] && m[1] !== speaker && m[1] !== botUserId) return m[1];
  }
  return null;
}

/** Link the owner is handing over: a link in the text, else the first file's permalink. */
export function sharedLink(s: Shared): string | undefined {
  return s.links[0] ?? s.files.find((f) => f.permalink)?.permalink ?? undefined;
}

function futureDue(i: ValidateInput): number | null {
  const at = parseDue(i.decision.deadline, i.tz);
  return at !== null && at > i.now ? at : null;
}

/** Builds the action with the values it needs, or null when a required value is missing. */
export function buildAction(kind: IntentKind, i: ValidateInput): AskAction | null {
  const note = clean(i.text);
  switch (kind) {
    case "accept_now": return { kind };
    case "accept_later": return { kind, deadlineAt: futureDue(i) };
    case "set_deadline": {
      const deadlineAt = futureDue(i);
      return deadlineAt === null ? null : { kind, deadlineAt };
    }
    case "done": return { kind, ...(note && { note }), ...(sharedLink(i) && { link: sharedLink(i) }) };
    case "ack": return note ? { kind, nextStep: note } : null;
    case "reject": return { kind, ...(note && { reason: note }) };
    case "send_back": return note ? { kind, question: note } : null;
    case "redirect": {
      const toUserId = mentionedUser(i.text, i.speaker, i.botUserId);
      return toUserId ? { kind, toUserId, ...(note && { note }) } : null;
    }
    case "close": return { kind };
    case "put_back": return note ? { kind, note } : null;
    case "withdraw": return { kind, ...(note && { note }) };
  }
}

export function validateDecision(i: ValidateInput): Outcome {
  const { p, ambiguous } = i.decision;
  const t = i.thresholds ?? JEV_THRESHOLDS;
  const picked = parseChoice(i.candidates, i.decision.choice);
  if (!picked || p < t.PROPOSE_P) return { kind: "none" };

  const action = buildAction(picked.kind, i);
  if (!action) return { kind: "none" };

  // Possibly meant for another ask: the speaker picks among every ask the action fits.
  const unsure = ambiguous >= t.AMBIGUOUS_P;
  const eligible = i.candidates.filter((c) => c.allowed.includes(picked.kind));
  return {
    kind: "act",
    action,
    askId: unsure ? null : picked.candidate.ask.id,
    eligible: unsure ? eligible : [picked.candidate],
    confidence: p,
    auto: !unsure && p >= t.AUTO_P,
  };
}

export interface Delivery {
  ask: AskRow;
  action: Extract<AskAction, { kind: "done" }>;
}

/**
 * "Looks done?" detector: the owner shares a file or link and System One says it delivers one of
 * their open asks. Never applied automatically, only proposed.
 */
export function detectDelivery(i: ValidateInput): Delivery | null {
  if (i.links.length === 0 && i.files.length === 0) return null;
  let best: Candidate | null = null;
  let bestP = (i.thresholds ?? JEV_THRESHOLDS).DELIVERS_P;
  for (const c of i.candidates) {
    const p = i.decision.delivers[c.ref] ?? 0;
    if (p < bestP || c.role !== "owner" || c.ask.owner_id !== i.speaker || !c.allowed.includes("done")) continue;
    best = c;
    bestP = p;
  }
  if (!best) return null;
  const link = sharedLink(i);
  const fileName = i.files.find((f) => f.name)?.name ?? undefined;
  return { ask: best.ask, action: { kind: "done", ...(link ? { link } : fileName ? { note: fileName } : {}) } };
}
