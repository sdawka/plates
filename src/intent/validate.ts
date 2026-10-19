// Pure validation of the intent model's output. Nothing here touches I/O: the model proposes,
// this decides what is allowed (per ask and speaker) and which values the action carries.

import { parseDue } from "../extract/dates";
import { availableActions } from "../domain/transitions";
import type { AskAction, AskRow } from "../types";

export const INTENT_KINDS = [
  "accept_now", "accept_later", "done", "ack", "reject", "send_back", "set_deadline", "redirect", "close", "put_back", "withdraw",
] as const satisfies readonly AskAction["kind"][];
export type IntentKind = (typeof INTENT_KINDS)[number];

/** At or above this (and a single candidate ask) the action is applied without asking. */
export const CONFIDENT = 0.8;
const MAX_NOTE = 500;

const isIntentKind = (v: unknown): v is IntentKind => typeof v === "string" && (INTENT_KINDS as readonly string[]).includes(v);

export interface Candidate {
  ref: string; // short handle shown to the model ("A1")
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

export interface ValidateInput extends Shared {
  raw: unknown;
  candidates: Candidate[];
  speaker: string;
  text: string;
  tz: string;
  now: number;
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
      confidence: number;
      /** Confident and unambiguous: apply now and offer Undo. */
      auto: boolean;
    };

interface RawDecision {
  action?: unknown;
  ask_id?: unknown;
  note?: unknown;
  deadline?: unknown;
  confidence?: unknown;
  delivers_ask_id?: unknown;
}

const asObject = (raw: unknown): RawDecision => (raw && typeof raw === "object" ? (raw as RawDecision) : {});
const clean = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = v.trim().slice(0, MAX_NOTE);
  return s || undefined;
};
const confidenceOf = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** The model may answer with our short ref or the real ask id. */
export function resolveCandidate(candidates: Candidate[], id: unknown): Candidate | null {
  if (typeof id !== "string" || !id) return null;
  return candidates.find((c) => c.ref === id || c.ask.id === id) ?? null;
}

/** First `<@U…>` mention in the reply that isn't the speaker. */
export function mentionedUser(text: string, speaker: string): string | null {
  for (const m of text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)) {
    if (m[1] && m[1] !== speaker) return m[1];
  }
  return null;
}

/** Link the owner is handing over: a link in the text, else the first file's permalink. */
export function sharedLink(s: Shared): string | undefined {
  return s.links[0] ?? s.files.find((f) => f.permalink)?.permalink ?? undefined;
}

function futureDue(value: unknown, i: ValidateInput): number | null {
  const at = parseDue(value, i.tz);
  return at !== null && at > i.now ? at : null;
}

/** Builds the action with the values it needs, or null when a required value is missing. */
export function buildAction(kind: IntentKind, d: RawDecision, i: ValidateInput): AskAction | null {
  const note = clean(d.note);
  switch (kind) {
    case "accept_now": return { kind };
    case "accept_later": return { kind, deadlineAt: futureDue(d.deadline, i) };
    case "set_deadline": {
      const deadlineAt = futureDue(d.deadline, i);
      return deadlineAt === null ? null : { kind, deadlineAt };
    }
    case "done": return { kind, ...(note && { note }), ...(sharedLink(i) && { link: sharedLink(i) }) };
    case "ack": return note ? { kind, nextStep: note } : null;
    case "reject": return { kind, ...(note && { reason: note }) };
    case "send_back": return note ? { kind, question: note } : null;
    case "redirect": {
      const toUserId = mentionedUser(i.text, i.speaker);
      return toUserId ? { kind, toUserId, ...(note && { note }) } : null;
    }
    case "close": return { kind };
    case "put_back": return note ? { kind, note } : null;
    case "withdraw": return { kind, ...(note && { note }) };
  }
}

export function validateDecision(i: ValidateInput): Outcome {
  const d = asObject(i.raw);
  if (!isIntentKind(d.action)) return { kind: "none" };
  const kind = d.action;

  const eligible = i.candidates.filter((c) => c.allowed.includes(kind));
  const named = resolveCandidate(i.candidates, d.ask_id);
  // The model named an ask this speaker can't do that to: never fall back to another one.
  if (named && !named.allowed.includes(kind)) return { kind: "none" };
  if (eligible.length === 0) return { kind: "none" };

  const action = buildAction(kind, d, i);
  if (!action) return { kind: "none" };

  const target = named ?? (eligible.length === 1 ? eligible[0]! : null);
  const confidence = confidenceOf(d.confidence);
  return {
    kind: "act",
    action,
    askId: target?.ask.id ?? null,
    eligible: named ? [named] : eligible,
    confidence,
    auto: target !== null && eligible.length === 1 && confidence >= CONFIDENT,
  };
}

export interface Delivery {
  ask: AskRow;
  action: Extract<AskAction, { kind: "done" }>;
}

/**
 * "Looks done?" detector: the owner shares a file or link and the model says it delivers one of
 * their open asks. Never applied automatically, only proposed.
 */
export function detectDelivery(i: ValidateInput): Delivery | null {
  if (i.links.length === 0 && i.files.length === 0) return null;
  const c = resolveCandidate(i.candidates, asObject(i.raw).delivers_ask_id);
  if (!c || c.role !== "owner" || c.ask.owner_id !== i.speaker || !c.allowed.includes("done")) return null;
  const link = sharedLink(i);
  const fileName = i.files.find((f) => f.name)?.name ?? undefined;
  return { ask: c.ask, action: { kind: "done", ...(link ? { link } : fileName ? { note: fileName } : {}) } };
}
