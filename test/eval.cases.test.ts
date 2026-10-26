// Every labelled eval case must name something the state machine offers, so labels can't drift from the product.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { intentQuestions, parseCases, parseJsonl, validateIntentCase, type Family, type IntentCase } from "../scripts/eval/cases";
import { oracleAnswers } from "../scripts/eval/score";

const FAMILIES: Family[] = ["intent", "is_ask", "reaction", "extract"];
const files = Object.fromEntries(FAMILIES.map((f) => [f, readFileSync(new URL(`../eval/cases/${f}.jsonl`, import.meta.url), "utf8")])) as Record<Family, string>;

describe("eval cases", () => {
  it("parse and validate, with the floors the plan set", () => {
    const cases = parseCases(files);
    expect(cases.intent.length).toBeGreaterThanOrEqual(60);
    expect(cases.is_ask.length).toBeGreaterThanOrEqual(40);
    expect(cases.reaction.length).toBeGreaterThanOrEqual(30);
    expect(cases.extract.length).toBeGreaterThanOrEqual(15);
    // every intent kind is labelled at least three times
    const kinds = new Map<string, number>();
    for (const c of cases.intent) {
      const k = c.expect.action === "none" ? "none" : c.expect.action.split(":")[1]!;
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
    for (const k of ["accept_now", "accept_later", "done", "ack", "reject", "send_back", "set_deadline", "redirect", "close", "put_back", "withdraw", "none"]) {
      expect(kinds.get(k) ?? 0, k).toBeGreaterThanOrEqual(3);
    }
  });

  it("every case has oracle answers for every question asked", () => {
    const cases = parseCases(files);
    for (const c of cases.intent) {
      const asked = Object.keys(intentQuestions(c).questions).sort();
      expect(oracleAnswers(cases, c.id).map((a) => a.id).sort(), c.id).toEqual(asked);
    }
  });

  it("rejects labels the state machine does not offer", () => {
    const base = parseJsonl<IntentCase>(files.intent)[0]!;
    expect(validateIntentCase({ ...base, expect: { ...base.expect, action: "A1:close" } })).toEqual([expect.stringContaining("not offered")]);
    expect(validateIntentCase({ ...base, expect: { action: "A1:accept_later", outcome: "auto", deadline: "2026-12-25" } })).toEqual([expect.stringContaining("outside the offered dates")]);
    expect(validateIntentCase({ ...base, speaker: "eve" })).toContainEqual(expect.stringContaining("no action"));
  });

  it("parseJsonl names the bad line", () => {
    expect(() => parseJsonl('{"a":1}\n\nnot json\n', "x.jsonl")).toThrow(/x\.jsonl:3/);
  });
});
