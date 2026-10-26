// Labelled cases for the decision-model eval (eval/cases/*.jsonl): types, parsing, validation, and the
// per-case inputs built with the production question builders, so the eval asks exactly what Plates asks.
// Pure: no I/O, so the loader is unit-tested and the same code scores recorded results.

import { parseDue } from "../../src/extract/dates";
import { buildIsAskQuestions, buildReactionQuestions } from "../../src/extract/questions";
import { buildIntentQuestions, type IntentQuestionInput } from "../../src/intent/questions";
import { buildCandidates } from "../../src/intent/validate";
import type { AskRow, AskState, AskType, Size } from "../../src/types";

/** The test harness's Monday, so `upcomingDates` and the "today" line are identical run to run. */
export const DEFAULT_NOW = "2026-10-19T10:00:00Z";
export const DEFAULT_TZ = "America/Toronto";
export const BOT_USER_ID = "UBOT";
/** dana asks, bob does, eve is a third party. */
export const PEOPLE = { dana: "UDANA", bob: "UBOB", eve: "UEVE" } as const;
export type Person = keyof typeof PEOPLE;

export type Family = "intent" | "is_ask" | "reaction" | "extract";
export const FAMILIES: readonly Family[] = ["intent", "is_ask", "reaction", "extract"];
/** Families the decision model answers (extract is for the Clairic spike). */
export const DECIDE_FAMILIES: readonly Family[] = ["intent", "is_ask", "reaction"];

export interface AskSpec {
  title: string;
  state?: AskState; // default proposed
  type?: AskType; // default deliverable
  size?: Size; // default hours
  owner?: Person; // default bob
  requester?: Person; // default dana
  /** Current deadline, local YYYY-MM-DD, or null. */
  deadline?: string | null;
}

export type Outcome3 = "auto" | "propose" | "none";

export interface IntentExpect {
  /** "none" or "<ref>:<kind>"; refs are A1, A2… in the order of `asks` the speaker is a party to. */
  action: string;
  /** What validateDecision should return at the model's thresholds. */
  outcome: Outcome3;
  /** Only when the deadline question is asked: the local date named, or null. */
  deadline?: string | null;
  /** Only when more than one ask has actions: the reply doesn't say which. */
  ambiguous?: boolean;
  /** Per ref, when a link or file is shared by an owner: it delivers that ask. */
  delivers?: Record<string, boolean>;
}

export interface IntentCase {
  id: string;
  source?: string;
  now?: string;
  tz?: string;
  speaker: Person;
  text: string;
  links?: string[];
  files?: { name: string | null; permalink: string | null }[];
  asks: AskSpec[];
  expect: IntentExpect;
}

export interface IsAskCase {
  id: string;
  text: string;
  expect: boolean;
}

export interface ReactionCase {
  id: string;
  emoji: string;
  reacted_by: Person;
  requester?: Person;
  owner?: Person;
  asks: string[];
  expect: "yes" | "no" | "unclear";
}

export interface ExtractCase {
  id: string;
  now?: string;
  tz?: string;
  messages: { ts: string; user: Person; text: string }[];
  expect: { asks: { title: string; due?: string | null }[] };
}

export interface Cases {
  intent: IntentCase[];
  is_ask: IsAskCase[];
  reaction: ReactionCase[];
  extract: ExtractCase[];
}

/** One JSON object per non-blank line. Errors name the line. */
export function parseJsonl<T>(text: string, name = "jsonl"): T[] {
  const out: T[] = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try {
      out.push(JSON.parse(line) as T);
    } catch (e) {
      throw new Error(`${name}:${i + 1}: ${(e as Error).message}`);
    }
  });
  return out;
}

export const nowOf = (c: { now?: string }): number => Date.parse(c.now ?? DEFAULT_NOW);
export const tzOf = (c: { tz?: string }): string => c.tz ?? DEFAULT_TZ;

export function askRows(c: IntentCase): AskRow[] {
  const now = nowOf(c);
  const tz = tzOf(c);
  return c.asks.map((a, i) => {
    const owner = PEOPLE[a.owner ?? "bob"];
    const requester = PEOPLE[a.requester ?? "dana"];
    const state = a.state ?? "proposed";
    const onOwner = state === "proposed" || state === "in_progress" || state === "accepted" || state === "snoozed";
    return {
      id: `ask-${i + 1}`,
      request_id: "R1",
      requester_id: requester,
      owner_id: owner,
      holder_id: onOwner ? owner : requester,
      title: a.title,
      detail: null,
      type: a.type ?? "deliverable",
      state,
      snoozed_from: state === "snoozed" ? "accepted" : null,
      size: a.size ?? "hours",
      size_source: "llm",
      urgency: "normal",
      urgency_source: "llm",
      estimate_reason: null,
      inferred_due_at: null,
      deadline_at: a.deadline ? parseDue(a.deadline, tz) : null,
      deadline_change_count: 0,
      snoozed_until: null,
      snooze_count: 0,
      round_count: 0,
      source_ts: null,
      source_permalink: null,
      next_step: null,
      done_link: null,
      last_note: null,
      created_at: now - 3_600_000 - i,
      accepted_at: null,
      closed_at: null,
      updated_at: now - 3_600_000,
      reminder_stage: 0,
      last_reminded_at: null,
      last_bumped_at: null,
      tracker_ref: null,
      tracker_url: null,
    };
  });
}

export function intentInput(c: IntentCase): IntentQuestionInput {
  const speaker = PEOPLE[c.speaker];
  return {
    speaker,
    text: c.text,
    tz: tzOf(c),
    now: nowOf(c),
    candidates: buildCandidates(askRows(c), speaker),
    links: c.links ?? [],
    files: c.files ?? [],
  };
}

export const intentQuestions = (c: IntentCase) => buildIntentQuestions(intentInput(c));
export const isAskQuestions = (c: IsAskCase) => buildIsAskQuestions(c.text);
export const reactionQuestions = (c: ReactionCase) =>
  buildReactionQuestions({
    emoji: c.emoji,
    reactedBy: PEOPLE[c.reacted_by],
    requester: PEOPLE[c.requester ?? "dana"],
    owner: PEOPLE[c.owner ?? "bob"],
    askTitles: c.asks,
  });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Problems with one intent case: labels must name something the state machine actually offers. */
export function validateIntentCase(c: IntentCase): string[] {
  const errs: string[] = [];
  if (!(c.speaker in PEOPLE)) return [`speaker: unknown person ${JSON.stringify(c.speaker)}`];
  if (c.asks.length === 0) errs.push("asks: at least one ask");
  const input = intentInput(c);
  if (input.candidates.every((x) => x.allowed.length === 0)) errs.push("speaker has no action on any ask (Plates would not ask the model)");
  if (!c.text.trim() && (c.files ?? []).length === 0) errs.push("text: empty and no files (Plates would not ask the model)");
  const { questions } = buildIntentQuestions(input);
  const action = questions.action;
  if (action?.type === "choice" && !(c.expect.action in action.criteria)) {
    errs.push(`expect.action: ${JSON.stringify(c.expect.action)} is not offered; options: ${Object.keys(action.criteria).join(", ")}`);
  }
  if (!["auto", "propose", "none"].includes(c.expect.outcome)) errs.push(`expect.outcome: ${JSON.stringify(c.expect.outcome)}`);
  if (c.expect.action === "none" && c.expect.outcome !== "none") errs.push("expect.outcome must be none when expect.action is none");
  const deadline = questions.deadline;
  if ("deadline" in c.expect) {
    const want = c.expect.deadline ?? null;
    if (!deadline) errs.push("expect.deadline given but the deadline question is not asked for these asks");
    else if (want !== null) {
      if (!DATE_RE.test(want)) errs.push(`expect.deadline: not YYYY-MM-DD`);
      else if (deadline.type === "choice" && !(want in deadline.criteria)) errs.push(`expect.deadline: ${want} is outside the offered dates`);
    }
  } else if (deadline) errs.push("expect.deadline required (null for no date) because the deadline question is asked");
  if ("ambiguous" in c.expect && !questions.ambiguous) errs.push("expect.ambiguous given but only one ask has actions");
  if (questions.ambiguous && !("ambiguous" in c.expect)) errs.push("expect.ambiguous required because more than one ask has actions");
  const deliverRefs = Object.keys(questions).filter((k) => k.startsWith("delivers_")).map((k) => k.slice("delivers_".length));
  for (const ref of Object.keys(c.expect.delivers ?? {})) if (!deliverRefs.includes(ref)) errs.push(`expect.delivers.${ref}: no delivers question for that ref`);
  for (const ref of deliverRefs) if (!(ref in (c.expect.delivers ?? {}))) errs.push(`expect.delivers.${ref} required (a link or file is shared)`);
  for (const a of c.asks) if (a.deadline && !DATE_RE.test(a.deadline)) errs.push(`asks.deadline: not YYYY-MM-DD`);
  return errs;
}

export function validateIsAskCase(c: IsAskCase): string[] {
  return typeof c.text === "string" && c.text.trim() && typeof c.expect === "boolean" ? [] : ["needs text and a boolean expect"];
}

export function validateReactionCase(c: ReactionCase): string[] {
  const errs: string[] = [];
  if (!c.emoji) errs.push("emoji required");
  if (!(c.reacted_by in PEOPLE)) errs.push("reacted_by: unknown person");
  if (!["yes", "no", "unclear"].includes(c.expect)) errs.push(`expect: ${JSON.stringify(c.expect)}`);
  if (!Array.isArray(c.asks) || c.asks.length === 0) errs.push("asks: at least one title");
  return errs;
}

export function validateExtractCase(c: ExtractCase): string[] {
  const errs: string[] = [];
  if (!Array.isArray(c.messages) || c.messages.length === 0) errs.push("messages: at least one");
  for (const m of c.messages ?? []) if (!(m.user in PEOPLE)) errs.push(`messages.user: unknown person ${JSON.stringify(m.user)}`);
  for (const a of c.expect?.asks ?? []) if (a.due && !DATE_RE.test(a.due)) errs.push(`expect.asks.due: not YYYY-MM-DD`);
  return errs;
}

/** Parse and validate every family; throws one error listing every problem. */
export function parseCases(files: Record<Family, string>): Cases {
  const cases: Cases = {
    intent: parseJsonl<IntentCase>(files.intent, "intent.jsonl"),
    is_ask: parseJsonl<IsAskCase>(files.is_ask, "is_ask.jsonl"),
    reaction: parseJsonl<ReactionCase>(files.reaction, "reaction.jsonl"),
    extract: parseJsonl<ExtractCase>(files.extract, "extract.jsonl"),
  };
  const problems: string[] = [];
  const check = <T extends { id: string }>(family: Family, list: T[], validate: (c: T) => string[]) => {
    const seen = new Set<string>();
    for (const c of list) {
      if (!c.id) problems.push(`${family}: a case has no id`);
      else if (seen.has(c.id)) problems.push(`${family}: duplicate id ${c.id}`);
      seen.add(c.id);
      let errs: string[];
      try {
        errs = validate(c);
      } catch (e) {
        errs = [(e as Error).message];
      }
      for (const e of errs) problems.push(`${family} ${c.id}: ${e}`);
    }
  };
  check("intent", cases.intent, validateIntentCase);
  check("is_ask", cases.is_ask, validateIsAskCase);
  check("reaction", cases.reaction, validateReactionCase);
  check("extract", cases.extract, validateExtractCase);
  if (problems.length) throw new Error(`invalid eval cases:\n  ${problems.join("\n  ")}`);
  return cases;
}
