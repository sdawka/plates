// Pure validation / normalisation of the model's extraction output. Never trust the model:
// drop what can't be verified, clamp enums, and keep only real participants.

import type { AskType, DraftAsk, Size, Urgency } from "../types";
import { parseDue } from "./dates";

export interface ExtractedGroup {
  requester_id: string | null;
  owner_id: string | null;
  attribution_confidence: number;
  attribution_reason: string | null;
  clarify_question: string | null;
  asks: DraftAsk[];
}

export interface ValidateCtx {
  /** Slack ts of every message given to the model. */
  messageTs: ReadonlySet<string>;
  /** Real (non-bot) participants and mentioned users. */
  userIds: ReadonlySet<string>;
  /** IANA tz of a user, "UTC" when unknown. */
  tzOf: (userId: string | null) => string;
  /** Permalinks already known for source messages (optional). */
  permalinks?: Readonly<Record<string, string | null>>;
}

const TYPES: readonly AskType[] = ["deliverable", "acknowledge", "decision", "info"];
const SIZES: readonly Size[] = ["2-5min", "lt1h", "hours", "days"];
const URGENCIES: readonly Urgency[] = ["low", "normal", "high", "urgent"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

/** Slack ids sometimes arrive as "<@U123>" or "@U123"; normalise to the bare id. */
export function normaliseUserId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^<?@?([UW][A-Z0-9]+)(?:\|[^>]*)?>?$/.exec(v.trim());
  return m?.[1] ?? null;
}

function clamp01(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

function normaliseAsk(raw: unknown, ctx: ValidateCtx, dueTz: string): DraftAsk | null {
  if (!isRecord(raw)) return null;
  const sourceTs = typeof raw.source_ts === "string" ? raw.source_ts.trim() : "";
  if (!ctx.messageTs.has(sourceTs)) return null;
  const title = text(raw.title, 140);
  if (!title) return null;

  const type = oneOf(raw.type, TYPES) ?? "deliverable";
  const size = oneOf(raw.size, SIZES) ?? (type === "acknowledge" ? "2-5min" : "lt1h");
  return {
    title,
    detail: text(raw.detail, 500),
    type,
    size,
    urgency: oneOf(raw.urgency, URGENCIES) ?? "normal",
    estimate_reason: text(raw.estimate_reason, 200) ?? "",
    inferred_due_at: parseDue(raw.inferred_due_at, dueTz),
    owner_already_committed: raw.owner_already_committed === true,
    source_ts: sourceTs,
    source_permalink: ctx.permalinks?.[sourceTs] ?? null,
  };
}

/** Normalise the tool output (`{ groups: [...] }`) into validated groups. Empty groups are dropped. */
export function validateGroups(raw: unknown, ctx: ValidateCtx): ExtractedGroup[] {
  const rawGroups = isRecord(raw) && Array.isArray(raw.groups) ? raw.groups : [];
  const out: ExtractedGroup[] = [];

  for (const g of rawGroups) {
    if (!isRecord(g)) continue;
    const requesterRaw = normaliseUserId(g.requester_id);
    const ownerRaw = normaliseUserId(g.owner_id);
    const requester = requesterRaw && ctx.userIds.has(requesterRaw) ? requesterRaw : null;
    const owner = ownerRaw && ctx.userIds.has(ownerRaw) ? ownerRaw : null;
    const dueTz = ctx.tzOf(requester ?? owner);

    const seen = new Set<string>();
    const asks: DraftAsk[] = [];
    for (const a of Array.isArray(g.asks) ? g.asks : []) {
      const ask = normaliseAsk(a, ctx, dueTz);
      if (!ask) continue;
      const key = `${ask.source_ts}|${ask.title.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      asks.push(ask);
    }
    if (asks.length === 0) continue;

    let confidence = clamp01(g.attribution_confidence);
    // An id we had to discard means we are no longer sure about that side.
    if ((requesterRaw && !requester) || (ownerRaw && !owner)) confidence = Math.min(confidence, 0.4);
    if (!requester || !owner) confidence = Math.min(confidence, 0.5);

    let clarify = text(g.clarify_question, 300);
    if (!clarify && (!requester || !owner)) {
      clarify = !requester && !owner ? "Who is asking, and who is it for?" : !requester ? "Who is asking for this?" : "Who should this go to?";
    }

    out.push({
      requester_id: requester,
      owner_id: owner,
      attribution_confidence: confidence,
      attribution_reason: text(g.attribution_reason, 300),
      clarify_question: clarify,
      asks,
    });
  }
  return out;
}

const AFFIRM_RE =
  /^(?:yes|yep|yeah|yup|y|correct|confirmed?|confirm|right|that'?s right|looks (?:good|right)|lgtm|ok(?:ay)?|sure|:\+1:|:white_check_mark:|:heavy_check_mark:|👍|✅|☑️)(?:[\s.!,]*(?:thanks|thank you|thx|please))?[\s.!]*$/iu;

/** True when a reply is just "yes" in some form (after stripping Slack mentions). */
export function isAffirmation(replyText: string): boolean {
  const cleaned = replyText.replace(/<@[UW][A-Z0-9]+(?:\|[^>]*)?>/g, "").trim();
  return cleaned.length > 0 && AFFIRM_RE.test(cleaned);
}

export const DEFAULT_REACTION_QUESTION = "✅ to confirm, ❌ to change.";
export const NO_ASK_REPLY =
  "I couldn't find an ask here — tell me what to put on whose plate, e.g. `@plates @bob send the Q3 numbers`";
