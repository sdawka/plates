import { describe, expect, it } from "vitest";
import { BUMP_INTERVAL_MS } from "../src/domain/service";
import { buildHomeView, type Block, type HomeData } from "../src/home/view";
import type { AskRow } from "../src/types";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

function ask(over: Partial<AskRow> & { id: string }): AskRow {
  return {
    request_id: "r1", requester_id: "UME", owner_id: "UOWN", holder_id: "UOWN", title: `Title ${over.id}`,
    detail: null, type: "deliverable", state: "accepted", snoozed_from: null, size: "lt1h", size_source: "llm",
    urgency: "normal", urgency_source: "llm", estimate_reason: null, inferred_due_at: null, deadline_at: null,
    deadline_change_count: 0, snoozed_until: null, snooze_count: 0, round_count: 0, source_ts: null,
    source_permalink: null, next_step: null, done_link: null, last_note: null, created_at: NOW - DAY,
    accepted_at: null, closed_at: null, updated_at: NOW - DAY, reminder_stage: 0, last_reminded_at: null,
    last_bumped_at: null, tracker_ref: null, tracker_url: null, ...over,
  };
}
const data = (over: Partial<HomeData>): HomeData => ({ plate: [], waiting: [], unconfirmed: [], ...over });
const json = (blocks: Block[]) => JSON.stringify(blocks);
const waitingActions = (blocks: Block[], id: string) =>
  (blocks.find((b) => b.block_id === `wait_actions:${id}`)?.elements ?? []) as { action_id: string; value?: string }[];

describe("Home: Bump", () => {
  it("offers Bump on waiting asks that sit on the owner's plate", () => {
    const { blocks } = buildHomeView(data({ waiting: [ask({ id: "a1" })] }), "UME", NOW);
    expect(waitingActions(blocks, "a1")[0]).toMatchObject({ action_id: "askx:bump", value: "a1" });
  });
  it("shows 'bumped today' instead of the button within the bump interval", () => {
    const recent = ask({ id: "a1", last_bumped_at: NOW - BUMP_INTERVAL_MS + 60_000 });
    const { blocks } = buildHomeView(data({ waiting: [recent] }), "UME", NOW);
    expect(json(blocks)).toContain("bumped today");
    expect(waitingActions(blocks, "a1").map((e) => e.action_id)).not.toContain("askx:bump");
  });
  it("offers Bump again after the interval", () => {
    const old = ask({ id: "a1", last_bumped_at: NOW - BUMP_INTERVAL_MS - 1 });
    const { blocks } = buildHomeView(data({ waiting: [old] }), "UME", NOW);
    expect(json(blocks)).not.toContain("bumped today");
    expect(waitingActions(blocks, "a1").map((e) => e.action_id)).toContain("askx:bump");
  });
  it("no Bump for asks already on the requester's plate", () => {
    const delivered = ask({ id: "a1", state: "delivered", holder_id: "UME" });
    const { blocks } = buildHomeView(data({ waiting: [delivered] }), "UME", NOW);
    expect(waitingActions(blocks, "a1").map((e) => e.action_id)).not.toContain("askx:bump");
  });
});

describe("Home: settings and tracker", () => {
  it("has a Settings button", () => {
    const { blocks } = buildHomeView(data({}), "UME", NOW);
    expect(json(blocks)).toContain('"action_id":"settings:open"');
  });
  it("links the tracker ticket on plate and waiting asks", () => {
    const t = { tracker_ref: "jira:PROJ-12", tracker_url: "https://jira.test/browse/PROJ-12" };
    const { blocks } = buildHomeView(data({ plate: [ask({ id: "a1", holder_id: "UME", owner_id: "UME", requester_id: "UX", ...t })], waiting: [ask({ id: "a2", ...t })] }), "UME", NOW);
    expect(json(blocks).split("<https://jira.test/browse/PROJ-12|PROJ-12>")).toHaveLength(3);
  });
  it("stays under Slack's 100 block limit with a long plate", () => {
    const many = Array.from({ length: 60 }, (_, i) => ask({ id: `a${i}` }));
    expect(buildHomeView(data({ waiting: many, plate: many.map((a) => ({ ...a, id: `p${a.id}`, holder_id: "UME", owner_id: "UME", requester_id: "UX" })) }), "UME", NOW).blocks.length).toBeLessThanOrEqual(100);
  });
});

describe("DM access row", () => {
  const els = (blocks: Block[]) => (blocks.find((b) => b.block_id === "dm_access_actions")?.elements ?? []) as Record<string, unknown>[];
  it("shows a Connect DMs URL button when not connected", () => {
    const { blocks } = buildHomeView(data({ dm: { connected: false, connectUrl: "https://w.test/oauth/start?state=x" } }), "UME", NOW);
    expect(els(blocks)[0]).toMatchObject({ url: "https://w.test/oauth/start?state=x", text: { text: "Connect DMs" } });
  });
  it("shows Disconnect DMs when connected and nothing when unavailable", () => {
    expect(els(buildHomeView(data({ dm: { connected: true, connectUrl: null } }), "UME", NOW).blocks)[0]).toMatchObject({ action_id: "oauth:disconnect" });
    expect(els(buildHomeView(data({ dm: { connected: false, connectUrl: null } }), "UME", NOW).blocks)).toEqual([]);
    expect(els(buildHomeView(data({}), "UME", NOW).blocks)).toEqual([]);
  });
});
