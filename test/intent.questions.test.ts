import { describe, expect, it } from "vitest";
import type { Answers, Question } from "../src/decide";
import { buildIntentQuestions, reduceIntentAnswers, type IntentQuestionInput } from "../src/intent/questions";
import { JEV_THRESHOLDS } from "../src/thresholds";
import { buildCandidates } from "../src/intent/validate";
import { mkAsk } from "./helpers/seed";

const NOW = Date.UTC(2026, 9, 19, 10); // Monday
const owner = "UOWN";
const asks = [mkAsk("R1", 1, { owner_id: owner, requester_id: "UREQ", holder_id: owner, state: "proposed" })];

function input(text: string): IntentQuestionInput {
  return { speaker: owner, text, tz: "America/Toronto", now: NOW, candidates: buildCandidates(asks, owner), links: [], files: [] };
}

const choice = (c: string, p: number, rest: Record<string, number> = {}) =>
  ({ type: "choice", choice: c, confidence: p, probabilities: { [c]: p, ...rest } }) as const;

describe("reduceIntentAnswers", () => {
  it("keeps the deadline only at or above the deadline threshold, and never 'none'", () => {
    const i = input("I'll get to it Thursday");
    const { questions } = buildIntentQuestions(i);
    expect(Object.keys(questions)).toContain("deadline");
    const base: Answers<Record<string, Question>> = { action: choice("A1:accept_later", 0.9) };

    const sure = reduceIntentAnswers({ ...base, deadline: choice("2026-10-22", 0.7) }, i, JEV_THRESHOLDS.DEADLINE_P);
    expect(sure).toMatchObject({ choice: "A1:accept_later", p: 0.9, deadline: "2026-10-22", ambiguous: 0, delivers: {} });

    const unsure = reduceIntentAnswers({ ...base, deadline: choice("2026-10-22", 0.4) }, i, JEV_THRESHOLDS.DEADLINE_P);
    expect(unsure.deadline).toBeNull();
    expect(reduceIntentAnswers({ ...base, deadline: choice("2026-10-22", 0.4) }, i, 0.3).deadline).toBe("2026-10-22");

    expect(reduceIntentAnswers({ ...base, deadline: choice("none", 0.99) }, i, 0).deadline).toBeNull();
  });

  it("throws (so the queue retries) when the action answer is missing", () => {
    expect(() => reduceIntentAnswers({}, input("ok"), 0.5)).toThrow(/no action answer/);
  });
});
