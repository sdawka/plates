import { describe, expect, it } from "vitest";
import { JEV_THRESHOLDS } from "../src/thresholds";
import { parseCases, type Cases } from "../scripts/eval/cases";
import { evalIntent, score, sweep, type RunRecord } from "../scripts/eval/score";

const intent = (id: string, text: string, speaker = "bob", extra = "") =>
  `{"id":"${id}","speaker":"${speaker}","text":"${text}","asks":[{"title":"Send the Q3 numbers"}],"expect":{"action":"A1:accept_later","outcome":"auto","deadline":"2026-10-22"${extra}}}`;
const cases: Cases = parseCases({
  intent: [intent("i1", "Thursday"), intent("i2", "lol").replace('"action":"A1:accept_later","outcome":"auto","deadline":"2026-10-22"', '"action":"none","outcome":"none","deadline":null')].join("\n"),
  is_ask: '{"id":"a1","text":"send the deck","expect":true}\n{"id":"a2","text":"hi","expect":false}',
  reaction: '{"id":"r1","emoji":"x","reacted_by":"dana","asks":["Send the Q3 numbers"],"expect":"no"}',
  extract: "",
});
const choice = (c: string, p: number) => ({ type: "choice" as const, choice: c, confidence: p, probabilities: { [c]: p } });
const noul = (p: number) => ({ type: "noul" as const, noul: p });

describe("evalIntent", () => {
  it("runs the production reducer and validator at the given thresholds", () => {
    const raw = { action: choice("A1:accept_later", 0.9), deadline: choice("2026-10-22", 0.6) };
    expect(evalIntent(cases.intent[0]!, raw, JEV_THRESHOLDS)).toMatchObject({ outcome: "auto", choice: "A1:accept_later", deadline: "2026-10-22" });
    expect(evalIntent(cases.intent[0]!, raw, { ...JEV_THRESHOLDS, AUTO_P: 0.95 }).outcome).toBe("propose");
    expect(evalIntent(cases.intent[0]!, raw, { ...JEV_THRESHOLDS, DEADLINE_P: 0.7 }).deadline).toBeNull();
  });
});

describe("score", () => {
  const records: RunRecord[] = [
    { id: "i1", family: "intent", raw: { action: choice("A1:accept_later", 0.9), deadline: choice("2026-10-22", 0.6) }, ms: 1 },
    { id: "i2", family: "intent", raw: { action: choice("A1:accept_now", 0.6), deadline: choice("none", 0.9) }, ms: 1 },
    { id: "a1", family: "is_ask", raw: { is_ask: noul(0.9) }, ms: 1 },
    { id: "a2", family: "is_ask", raw: { is_ask: noul(0.4) }, ms: 1 },
    { id: "r1", family: "reaction", raw: { meaning: choice("no", 0.7) }, ms: 1 },
  ];
  const s = score(cases, records, JEV_THRESHOLDS);

  it("counts accuracy and confusions at the current thresholds", () => {
    expect(s.intent).toMatchObject({ n: 2, correct: 1, actionCorrect: 1, deadlineN: 2, deadlineCorrect: 2 });
    expect(s.intent.outcome).toEqual({ auto: { auto: 1 }, none: { propose: 1 } });
    expect(s.intent.kinds).toEqual({ accept_later: { accept_later: 1 }, none: { accept_now: 1 } });
    expect(s.intent.deadline).toEqual({ date: { "date-correct": 1 }, "no date": { "null-correct": 1 } });
    expect(s.is_ask).toMatchObject({ n: 2, correct: 1 }); // 0.4 >= 0.3 is a false positive
    expect(s.is_ask.wrong).toEqual([{ id: "a2", expect: "false", got: "true p=0.40", ok: false }]);
    expect(s.reaction).toMatchObject({ n: 1, correct: 0 }); // 0.7 < 0.8 -> unclear
  });

  it("sweeps each threshold and suggests the best F1 that differs from the current value", () => {
    const isAsk = s.sweeps.IS_ASK_MIN!;
    expect(isAsk.find((r) => r.x === 0.3)!.pr).toMatchObject({ tp: 1, fp: 1, fn: 0 });
    expect(isAsk.find((r) => r.x === 0.5)!.pr).toMatchObject({ tp: 1, fp: 0, fn: 0, f1: 1 });
    expect(s.suggested.IS_ASK_MIN).toBe(0.45); // nearest-to-current among the ties at F1 = 1
    expect(s.suggested.REACTION_MIN).toBe(0.7);
    // PROPOSE_P at 0.65 drops the i2 false positive (p = 0.6) and keeps i1 (p = 0.9)
    expect(s.sweeps.PROPOSE_P!.find((r) => r.x === 0.65)!.pr).toMatchObject({ tp: 1, fp: 0, fn: 0 });
    expect(s.suggested.PROPOSE_P).toBe(0.65);
  });

  it("sweep ties go to the row nearest the current value", () => {
    const rows = sweep("AUTO_P", JEV_THRESHOLDS, [1, 2], () => true, () => ({ predicted: true, correct: true }));
    expect(rows.filter((r) => r.best).map((r) => r.x)).toEqual([0.85]);
  });
});
