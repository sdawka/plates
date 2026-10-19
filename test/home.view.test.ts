import { describe, expect, it } from "vitest";
import { buildHomeView, MAX_BLOCKS, type Block, type HomeData } from "../src/home/view";
import type { AskRow, RequestRow } from "../src/types";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

function ask(over: Partial<AskRow> & { id: string }): AskRow {
  return {
    request_id: "r1", requester_id: "UREQ", owner_id: "UME", holder_id: "UME", title: `Title ${over.id}`,
    detail: null, type: "deliverable", state: "accepted", snoozed_from: null, size: "lt1h", size_source: "llm",
    urgency: "normal", urgency_source: "llm", estimate_reason: null, inferred_due_at: null, deadline_at: null,
    deadline_change_count: 0, snoozed_until: null, snooze_count: 0, round_count: 0, source_ts: null,
    source_permalink: null, next_step: null, done_link: null, last_note: null, created_at: NOW - DAY,
    accepted_at: null, closed_at: null, updated_at: NOW - DAY, reminder_stage: 0, last_reminded_at: null,
    last_bumped_at: null, tracker_ref: null, tracker_url: null, ...over,
  };
}

function request(over: Partial<RequestRow> & { id: string }): RequestRow {
  return {
    channel_id: "C1", thread_ts: "1.1", message_ts: null, status: "pending_confirmation", tagged_by_id: "UTAG", tag_message_ts: null,
    requester_id: "UREQ", owner_id: "UME", attribution_confidence: 0.9, attribution_reason: null,
    clarify_question: null, draft_json: JSON.stringify([{ title: "Draft item" }]), confirmed_by: null,
    confirmed_via: null, nudged_at: null, created_at: NOW, updated_at: NOW, ...over,
  };
}

const empty: HomeData = { plate: [], waiting: [], unconfirmed: [] };
const text = (blocks: Block[]) => JSON.stringify(blocks);
const find = (blocks: Block[], prefix: string) => blocks.filter((b) => String(b.block_id ?? "").startsWith(prefix));
const buttonIds = (b: Block | undefined) =>
  ((b?.elements as { action_id: string; value?: string; type: string }[]) ?? []).map((e) => e.action_id);

describe("buildHomeView", () => {
  it("shows friendly empty states", () => {
    const { blocks } = buildHomeView(empty, "UME", NOW);
    expect(text(blocks)).toContain("Nothing waiting on you");
    expect(text(blocks)).toContain("You aren't waiting on anyone");
  });

  it("summarises plate by size", () => {
    const plate = [ask({ id: "a", size: "hours" }), ask({ id: "b", size: "lt1h" }), ask({ id: "c", size: "lt1h" })];
    expect(text(buildHomeView({ ...empty, plate }, "UME", NOW).blocks)).toContain("1 × few hours · 2 × &lt;1 hr");
  });

  it("orders plate: in progress, deadline soonest, no date, snoozed; grouped by requester", () => {
    const plate = [
      ask({ id: "snz", state: "snoozed", snoozed_until: NOW + DAY, snooze_count: 2 }),
      ask({ id: "nodate", state: "accepted" }),
      ask({ id: "late", state: "accepted", deadline_at: NOW + 5 * DAY }),
      ask({ id: "soon", state: "accepted", deadline_at: NOW + DAY }),
      ask({ id: "wip", state: "in_progress" }),
      ask({ id: "other", state: "accepted", requester_id: "UOTH", deadline_at: NOW + 2 * DAY }),
    ];
    const blocks = buildHomeView({ ...empty, plate }, "UME", NOW).blocks;
    const ids = find(blocks, "plate:").map((b) => b.block_id);
    // UREQ's group first (holds the most urgent ask), then UOTH
    expect(ids).toEqual(["plate:wip", "plate:soon", "plate:late", "plate:nodate", "plate:snz", "plate:other"]);
    expect(blocks.filter((b) => b.type === "context" && text([b]).includes("From <@UREQ>"))).toHaveLength(1);
    expect(text(find(blocks, "plate:snz"))).toContain("💤×2");
  });

  it("gives the owner accept buttons on proposed asks and splits extra actions to an overflow", () => {
    const blocks = buildHomeView({ ...empty, plate: [ask({ id: "p", state: "proposed" })] }, "UME", NOW).blocks;
    const actions = find(blocks, "resp_actions:")[0];
    const els = actions?.elements as { type: string; options?: { value: string }[] }[];
    expect(buttonIds(actions).slice(0, 3)).toEqual(["ask:accept_now", "ask:accept_later", "ask:reject"]);
    const menu = els.find((e) => e.type === "overflow");
    expect(buttonIds(actions)).toContain("ask:overflow");
    expect(menu?.options?.every((o) => /^ask:[a-z_]+\|p$/.test(o.value))).toBe(true);
  });

  it("gives the requester Close and Put back on delivered asks, not owner actions", () => {
    const delivered = ask({ id: "d", state: "delivered", holder_id: "UREQ", requester_id: "UME", owner_id: "UOWN", last_note: "shipped", done_link: "https://x.test" });
    const blocks = buildHomeView({ ...empty, plate: [delivered] }, "UME", NOW).blocks;
    const ids = buttonIds(find(blocks, "resp_actions:")[0]);
    expect(ids.slice(0, 2)).toEqual(["ask:close", "ask:put_back"]);
    expect(ids).not.toContain("ask:done");
    expect(text(blocks)).toContain("shipped");
    expect(text(blocks)).toContain("https://x.test");
  });

  it("shows waiting asks with bump and withdraw, and their age", () => {
    const waiting = ask({ id: "w", requester_id: "UME", owner_id: "UBOB", holder_id: "UBOB", state: "accepted", created_at: NOW - 3 * DAY });
    const blocks = buildHomeView({ ...empty, waiting: [waiting] }, "UME", NOW).blocks;
    expect(buttonIds(find(blocks, "wait_actions:")[0])).toEqual(["askx:bump", "ask:withdraw"]);
    expect(text(blocks)).toContain("asked 3d ago");
    expect(text(blocks)).toContain("<@UBOB>");
  });

  it("shows Confirm only to requester or owner on unconfirmed requests", () => {
    const unconfirmed = [request({ id: "q1" })];
    const asOwner = buildHomeView({ ...empty, unconfirmed }, "UME", NOW).blocks;
    expect(buttonIds(find(asOwner, "unconf_actions:")[0])).toContain("req:confirm");
    const asTagger = buildHomeView({ ...empty, unconfirmed }, "UTAG", NOW).blocks;
    const tagIds = buttonIds(find(asTagger, "unconf_actions:")[0]);
    expect(tagIds).not.toContain("req:confirm");
    expect(tagIds).toContain("req:open_thread");
    expect(text(asOwner)).toContain("Draft item");
  });

  it("stays within 100 blocks and reports truncation", () => {
    const many = (n: number, over: Partial<AskRow>) => Array.from({ length: n }, (_, i) => ask({ ...over, id: `${over.state}${i}` }));
    const data: HomeData = {
      plate: [...many(40, { state: "proposed" }), ...many(60, { state: "accepted" })],
      waiting: many(40, { requester_id: "UME", owner_id: "UB", holder_id: "UB" }),
      unconfirmed: Array.from({ length: 30 }, (_, i) => request({ id: `u${i}` })),
    };
    const blocks = buildHomeView(data, "UME", NOW).blocks;
    expect(blocks.length).toBeLessThanOrEqual(MAX_BLOCKS);
    expect(text(blocks)).toMatch(/…and \d+ more/);
  });
});
