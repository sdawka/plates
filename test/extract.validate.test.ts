import { describe, expect, it } from "vitest";
import { localDateInfo, parseDue, zonedTimeToEpoch } from "../src/extract/dates";
import { isAffirmation, normaliseUserId, validateGroups, type ValidateCtx } from "../src/extract/validate";

const ctx: ValidateCtx = {
  messageTs: new Set(["100.000", "101.000"]),
  userIds: new Set(["U1", "U2"]),
  tzOf: (id) => (id === "U1" ? "America/New_York" : "UTC"),
};

const ask = (over: Record<string, unknown> = {}) => ({
  title: "Send Q3 numbers",
  type: "deliverable",
  size: "hours",
  urgency: "high",
  estimate_reason: "needs data pull",
  owner_already_committed: false,
  source_ts: "100.000",
  ...over,
});

describe("dates", () => {
  it("converts wall time in a zone, across DST", () => {
    expect(zonedTimeToEpoch(2026, 1, 15, 17, 0, "America/New_York")).toBe(Date.UTC(2026, 0, 15, 22, 0));
    expect(zonedTimeToEpoch(2026, 7, 15, 17, 0, "America/New_York")).toBe(Date.UTC(2026, 6, 15, 21, 0));
    expect(zonedTimeToEpoch(2026, 7, 15, 17, 0, "Asia/Kolkata")).toBe(Date.UTC(2026, 6, 15, 11, 30));
  });
  it("falls back to UTC for unknown tz", () => {
    expect(zonedTimeToEpoch(2026, 1, 1, 0, 0, "Nope/Zone")).toBe(Date.UTC(2026, 0, 1));
  });
  it("parses date-only as end of day and datetime as given", () => {
    expect(parseDue("2026-10-23", "UTC")).toBe(Date.UTC(2026, 9, 23, 23, 59));
    expect(parseDue("2026-10-23T17:00", "America/New_York")).toBe(Date.UTC(2026, 9, 23, 21, 0));
  });
  it("rejects garbage and impossible dates", () => {
    expect(parseDue("friday", "UTC")).toBeNull();
    expect(parseDue("2026-02-31", "UTC")).toBeNull();
    expect(parseDue(null, "UTC")).toBeNull();
  });
  it("reports local date", () => {
    expect(localDateInfo(Date.UTC(2026, 9, 18, 3, 0), "America/New_York").date).toBe("2026-10-17");
  });
});

describe("validateGroups", () => {
  it("keeps a valid group and converts due date in requester tz", () => {
    const out = validateGroups(
      { groups: [{ requester_id: "U1", owner_id: "U2", attribution_confidence: 0.9, attribution_reason: "r", asks: [ask({ inferred_due_at: "2026-10-23T17:00" })] }] },
      ctx,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.asks[0]?.inferred_due_at).toBe(Date.UTC(2026, 9, 23, 21, 0));
    expect(out[0]?.attribution_confidence).toBe(0.9);
    expect(out[0]?.clarify_question).toBeNull();
  });

  it("drops asks with unknown source_ts and empty groups", () => {
    const out = validateGroups(
      { groups: [{ requester_id: "U1", owner_id: "U2", attribution_confidence: 1, asks: [ask({ source_ts: "999.0" })] }] },
      ctx,
    );
    expect(out).toEqual([]);
  });

  it("nulls unknown ids, lowers confidence and synthesises a question", () => {
    const [g] = validateGroups(
      { groups: [{ requester_id: "U1", owner_id: "U999", attribution_confidence: 0.95, asks: [ask()] }] },
      ctx,
    );
    expect(g?.owner_id).toBeNull();
    expect(g?.attribution_confidence).toBeLessThanOrEqual(0.4);
    expect(g?.clarify_question).toBeTruthy();
  });

  it("accepts <@U1> style ids and clamps enums", () => {
    const [g] = validateGroups(
      {
        groups: [
          {
            requester_id: "<@U1>",
            owner_id: "U2",
            attribution_confidence: 7,
            asks: [ask({ type: "weird", size: "huge", urgency: "asap" }), ask({ type: "acknowledge", size: "huge", title: "Ack" })],
          },
        ],
      },
      ctx,
    );
    expect(g?.requester_id).toBe("U1");
    expect(g?.attribution_confidence).toBe(1);
    expect(g?.asks[0]).toMatchObject({ type: "deliverable", size: "lt1h", urgency: "normal" });
    expect(g?.asks[1]).toMatchObject({ type: "acknowledge", size: "2-5min" });
  });

  it("de-dupes identical asks and tolerates junk input", () => {
    const [g] = validateGroups({ groups: [{ requester_id: "U1", owner_id: "U2", asks: [ask(), ask(), null, "x"] }] }, ctx);
    expect(g?.asks).toHaveLength(1);
    expect(validateGroups(null, ctx)).toEqual([]);
    expect(validateGroups({ groups: "no" }, ctx)).toEqual([]);
  });

  it("fills permalinks from context", () => {
    const [g] = validateGroups(
      { groups: [{ requester_id: "U1", owner_id: "U2", asks: [ask()] }] },
      { ...ctx, permalinks: { "100.000": "https://x/p1" } },
    );
    expect(g?.asks[0]?.source_permalink).toBe("https://x/p1");
  });
});

describe("helpers", () => {
  it("detects affirmations", () => {
    for (const t of ["yes", "Yes!", "correct", "👍", ":+1:", "<@UBOT> yes", "looks good", "lgtm."]) expect(isAffirmation(t)).toBe(true);
    for (const t of ["no, it's from me", "yes but drop the intro", "", "it's Carol not Bob"]) expect(isAffirmation(t)).toBe(false);
  });
  it("normalises user ids", () => {
    expect(normaliseUserId("<@U123ABC>")).toBe("U123ABC");
    expect(normaliseUserId("U123ABC")).toBe("U123ABC");
    expect(normaliseUserId("bob")).toBeNull();
  });
});
