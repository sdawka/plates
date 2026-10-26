import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decide, pMax, type ChoiceAnswer, type ScoreAnswer } from "../src/decide";
import { upcomingDates } from "../src/extract/dates";
import { LlmPermanentError } from "../src/llm";
import type { Env } from "../src/types";
import { FakeSystemOne, SYSTEMONE_KEY } from "./helpers/fakeSystemOne";
import { Network } from "./helpers/net";

const BASE = "https://llm.test";
let net: Network;
let fake: FakeSystemOne;
const env = { OPENROUTER_API_KEY: SYSTEMONE_KEY, DECIDE_MODEL: "typesafe/jev-1.14", LLM_BASE_URL: BASE, PUBLIC_URL: "https://plates.test" } as Env;

beforeEach(() => {
  net = new Network();
  fake = new FakeSystemOne();
  fake.attach(net, BASE);
  net.install();
});
afterEach(() => net.uninstall());

const yesNo = { type: "noul", instructions: "It is raining." } as const;
const pick = { type: "choice", instructions: "Pick.", criteria: { a: "first", "x:b": null } } as const;

describe("decide", () => {
  it("posts model, state and questions with the OpenRouter headers, and returns typed answers", async () => {
    fake.queueNoul("rain", 0.98).queueChoice("pick", "x:b", 0.9);
    const a = await decide(env, { state: { today: "Monday" }, sessionId: "s1", questions: { rain: yesNo, pick } });
    expect(a.rain.noul).toBe(0.98);
    expect(a.pick.choice).toBe("x:b");
    expect(pMax(a.pick)).toBeCloseTo(0.9);

    const req = fake.requests[0]!;
    expect(req.body).toEqual({ model: "typesafe/jev-1.14", session_id: "s1", state: { today: "Monday" }, questions: { rain: yesNo, pick } });
    expect(req.headers).toMatchObject({ authorization: `Bearer ${SYSTEMONE_KEY}`, "x-openrouter-title": "Plates", "http-referer": "https://plates.test" });
  });

  it("makes one attempt: 429 and 5xx throw a plain error for the queue to retry", async () => {
    for (const status of [429, 502, 503, 524, 529]) {
      fake.failNext(status, "later");
      const err = await decide(env, { state: "s", questions: { rain: yesNo } }).catch((e: unknown) => e);
      expect(err, String(status)).toBeInstanceOf(Error);
      expect(err, String(status)).not.toBeInstanceOf(LlmPermanentError);
      expect((err as Error).message).toContain(String(status));
    }
    expect(fake.requests).toHaveLength(5);
  });

  it("400, 401, 402 and 422 are permanent", async () => {
    for (const status of [400, 401, 402, 422]) {
      fake.failNext(status, "no");
      await expect(decide(env, { state: "s", questions: { rain: yesNo } }), String(status)).rejects.toBeInstanceOf(LlmPermanentError);
    }
  });

  it("a wrong key is a permanent 401; nothing scripted is a permanent 400", async () => {
    await expect(decide({ ...env, OPENROUTER_API_KEY: "nope" }, { state: "s", questions: { rain: yesNo } })).rejects.toBeInstanceOf(LlmPermanentError);
    await expect(decide(env, { state: "s", questions: { rain: yesNo } })).rejects.toBeInstanceOf(LlmPermanentError);
    expect(fake.unscripted).toHaveLength(1);
  });

  it("an answer of the wrong type is a transient error", async () => {
    net.uninstall();
    net = new Network();
    net.route(`${BASE}/v1/systemone`, () => Response.json({ answers: { rain: { type: "choice", choice: "a", confidence: 1, probabilities: { a: 1 } } } }));
    net.install();
    const err = await decide(env, { state: "s", questions: { rain: yesNo } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(LlmPermanentError);
  });
});

describe("pMax", () => {
  it("is the probability of the chosen option, not the rescaled confidence", () => {
    const a: ChoiceAnswer = { type: "choice", choice: "a", confidence: 0.2, probabilities: { a: 0.6, b: 0.4 } };
    expect(pMax(a)).toBe(0.6);
    expect(pMax({ ...a, choice: "zzz" })).toBe(0);
  });
  it("is the top level for a score", () => {
    const s: ScoreAnswer = { type: "score", score: 0.5, confidence: 0.1, probabilities: { "0": 0.2, "1": 0.5, "2": 0.3 } };
    expect(pMax(s)).toBe(0.5);
  });
});

describe("FakeSystemOne validates like the API", () => {
  const post = (body: unknown) =>
    net.fetch(new Request(`${BASE}/v1/systemone`, { method: "POST", headers: { authorization: `Bearer ${SYSTEMONE_KEY}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
  const ok = { model: "typesafe/jev-1.14", state: "s" };

  it("rejects an unknown model, a bad question id, a choice without criteria and too many options", async () => {
    fake.alwaysNoul("a:b", 0.5);
    const cases: [string, unknown][] = [
      ["model", { ...ok, model: "gpt-5", questions: { q: yesNo } }],
      ["id charset", { ...ok, questions: { "a:b": yesNo } }],
      ["criteria", { ...ok, questions: { q: { type: "choice", instructions: "x" } } }],
      ["options", { ...ok, questions: { q: { type: "choice", instructions: "x", criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, null])) } } }],
      ["score levels", { ...ok, questions: { q: { type: "score", instructions: "x", criteria: ["only"] } } }],
      ["no questions", { ...ok, questions: {} }],
    ];
    for (const [label, body] of cases) expect((await post(body)).status, label).toBe(400);
  });

  it("accepts 255 options and option keys containing ':'", async () => {
    const criteria = Object.fromEntries(Array.from({ length: 255 }, (_, i) => [`o:${i}`, null]));
    fake.queueChoice("q", "o:7");
    const res = await post({ ...ok, questions: { q: { type: "choice", instructions: "x", criteria } } });
    expect(res.status).toBe(200);
  });
});

describe("upcomingDates", () => {
  it("lists local calendar dates from today with weekday labels", () => {
    const d = upcomingDates(Date.UTC(2026, 9, 19, 10), "UTC", 21);
    expect(d).toHaveLength(21);
    expect(d[0]).toEqual({ date: "2026-10-19", label: "Monday Oct 19" });
    expect(d[3]).toEqual({ date: "2026-10-22", label: "Thursday Oct 22" });
    expect(d[20]).toEqual({ date: "2026-11-08", label: "Sunday Nov 8" });
  });
  it("starts from the speaker's local date and crosses a DST change without skipping a day", () => {
    expect(upcomingDates(Date.UTC(2026, 9, 19, 20), "Asia/Tokyo", 2).map((x) => x.date)).toEqual(["2026-10-20", "2026-10-21"]);
    const dates = upcomingDates(Date.UTC(2026, 9, 30, 12), "America/New_York", 5).map((x) => x.date);
    expect(dates).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"]);
  });
});

describe("DECIDE_API", () => {
  it("posts the same body to /alpha/decisions when set to decisions", async () => {
    fake.queueNoul("rain", 0.7);
    const a = await decide({ ...env, DECIDE_API: "decisions", DECIDE_MODEL: "cloudflare/clef-flash" }, { state: "s", questions: { rain: yesNo } });
    expect(a.rain.noul).toBe(0.7);
    expect(fake.requests.map((r) => r.path)).toEqual(["/alpha/decisions"]);
    expect(fake.requests[0]!.body).toEqual({ model: "cloudflare/clef-flash", state: "s", questions: { rain: yesNo } });
  });

  it("defaults to /v1/systemone", async () => {
    fake.queueNoul("rain", 0.7);
    await decide(env, { state: "s", questions: { rain: yesNo } });
    expect(fake.requests.map((r) => r.path)).toEqual(["/v1/systemone"]);
  });

  it("rejects an unknown value permanently, without a request", async () => {
    const err = await decide({ ...env, DECIDE_API: "nope" as never }, { state: "s", questions: { rain: yesNo } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmPermanentError);
    expect(fake.requests).toHaveLength(0);
  });
});
