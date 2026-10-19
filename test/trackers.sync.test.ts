import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncTracker } from "../src/trackers";
import { buildDescription, isoDate, planSync } from "../src/trackers/describe";
import type { AskRow, Env } from "../src/types";
import { asD1, makeDb, type FakeD1 } from "./helpers/fakeD1";

interface Call {
  method: string;
  url: string;
  body: any;
}

let fake: FakeD1;
let calls: Call[];
let slackEmails: Record<string, string | null>;
let jiraUsers: Record<string, string>;
let linearUsers: Record<string, string>;
let jiraTransitions: any[];
let slackTz: Record<string, string>;

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });

const JIRA_TRANSITIONS = [
  { id: "11", name: "To Do", to: { name: "To Do", statusCategory: { key: "new" } } },
  { id: "21", name: "Start", to: { name: "In Progress", statusCategory: { key: "indeterminate" } } },
  { id: "31", name: "Done", to: { name: "Done", statusCategory: { key: "done" } } },
  { id: "41", name: "Won't do", to: { name: "Won't Do", statusCategory: { key: "done" } } },
];

function mockFetch() {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const body = typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : init.body;
    calls.push({ method: init.method ?? "GET", url, body });
    if (url.startsWith("https://slack.test/api/users.info")) {
      const id = new URLSearchParams(body as string).get("user")!;
      return json({ ok: true, user: { name: id.toLowerCase(), tz: slackTz[id], profile: { real_name: `Name ${id}`, email: slackEmails[id] } } });
    }
    if (url.includes("atlassian.test")) {
      if (url.includes("/user/search")) {
        const q = decodeURIComponent(url.split("query=")[1]!);
        return json(jiraUsers[q] ? [{ accountId: jiraUsers[q], emailAddress: q, accountType: "atlassian" }] : []);
      }
      if (url.endsWith("/rest/api/3/issue")) return json({ id: "10001", key: "PLT-12", self: "https://atlassian.test/rest/api/3/issue/10001" }, 201);
      if (url.endsWith("/transitions") && init.method === "GET") return json({ transitions: jiraTransitions });
      if (init.method === "PUT") return new Response(null, { status: 204 });
      if (init.method === "POST") return new Response(url.endsWith("/comment") ? "{}" : null, { status: url.endsWith("/comment") ? 201 : 204 });
    }
    if (url === "https://linear.test/graphql") {
      const q: string = body.query;
      if (q.includes("users(")) {
        const id = linearUsers[body.variables.email];
        return json({ data: { users: { nodes: id ? [{ id }] : [] } } });
      }
      if (q.includes("issueCreate")) {
        return json({ data: { issueCreate: { success: true, issue: { id: "lin-uuid", identifier: "ENG-34", url: "https://linear.app/x/issue/ENG-34" } } } });
      }
      if (q.includes("team(")) {
        return json({
          data: {
            team: {
              states: {
                nodes: [
                  { id: "s-backlog", name: "Backlog", type: "backlog", position: 0 },
                  { id: "s-todo", name: "Todo", type: "unstarted", position: 1 },
                  { id: "s-doing", name: "In Progress", type: "started", position: 2 },
                  { id: "s-done", name: "Done", type: "completed", position: 3 },
                  { id: "s-cancel", name: "Canceled", type: "canceled", position: 4 },
                ],
              },
            },
          },
        });
      }
      if (q.includes("issueUpdate")) return json({ data: { issueUpdate: { success: true } } });
      if (q.includes("commentCreate")) return json({ data: { commentCreate: { success: true } } });
    }
    return new Response("unexpected " + url, { status: 500 });
  });
}

const jiraEnv = (over: Partial<Env> = {}): Env =>
  ({
    DB: asD1(fake),
    SLACK_BOT_TOKEN: "xoxb",
    SLACK_API_URL: "https://slack.test/api",
    TRACKER: "jira",
    JIRA_BASE_URL: "https://atlassian.test",
    JIRA_EMAIL: "bot@x.com",
    JIRA_API_TOKEN: "tok",
    JIRA_PROJECT_KEY: "PLT",
    ...over,
  }) as Env;

const linearEnv = (): Env =>
  jiraEnv({ TRACKER: "linear", LINEAR_API_KEY: "lin_key", LINEAR_TEAM_ID: "team1", LINEAR_API_URL: "https://linear.test/graphql" });

function insertAsk(over: Partial<AskRow> = {}) {
  fake.sqlite
    .prepare(
      `INSERT OR IGNORE INTO requests (id, channel_id, thread_ts, status, tagged_by_id, draft_json, created_at, updated_at)
       VALUES ('r1', 'C1', '1.1', 'confirmed', 'U_REQ', '[]', 1, 1)`,
    )
    .run();
  const a: Record<string, unknown> = {
    id: "a1", request_id: "r1", requester_id: "U_REQ", owner_id: "U_OWN", holder_id: "U_OWN",
    title: "Ship the report", detail: "Quarterly numbers", type: "deliverable", state: "accepted",
    size: "hours", urgency: "high", estimate_reason: "needs data pulls", deadline_at: Date.UTC(2026, 10, 5),
    source_permalink: "https://slack.test/archives/C1/p1", created_at: 1, updated_at: 1,
    ...over,
  };
  const cols = Object.keys(a);
  fake.sqlite.prepare(`INSERT INTO asks (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...(Object.values(a) as any[]));
}
const setAsk = (patch: Record<string, unknown>) => {
  const cols = Object.keys(patch);
  fake.sqlite.prepare(`UPDATE asks SET ${cols.map((c) => `${c} = ?`).join(",")} WHERE id = 'a1'`).run(...(Object.values(patch) as any[]));
};
const askRow = () => fake.all("SELECT * FROM asks WHERE id = 'a1'")[0] as any;

beforeEach(() => {
  fake = makeDb();
  calls = [];
  jiraTransitions = JIRA_TRANSITIONS;
  slackTz = {};
  slackEmails = { U_REQ: "req@x.com", U_OWN: "own@x.com" };
  jiraUsers = { "own@x.com": "acc-own" };
  linearUsers = { "own@x.com": "lin-own" };
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mockFetch();
});
afterEach(() => vi.unstubAllGlobals());

describe("no-op conditions", () => {
  it("does nothing when TRACKER is unset", async () => {
    insertAsk();
    await syncTracker(jiraEnv({ TRACKER: undefined }), "a1");
    expect(calls).toHaveLength(0);
  });
  it("does nothing when credentials are missing", async () => {
    insertAsk();
    await syncTracker(jiraEnv({ JIRA_API_TOKEN: undefined }), "a1");
    await syncTracker({ ...linearEnv(), LINEAR_API_KEY: undefined } as Env, "a1");
    expect(calls).toHaveLength(0);
  });
  it("ignores non-deliverable asks, unaccepted asks and unknown asks", async () => {
    insertAsk({ type: "decision" });
    await syncTracker(jiraEnv(), "a1");
    await syncTracker(jiraEnv(), "nope");
    setAsk({ type: "deliverable", state: "proposed" });
    await syncTracker(jiraEnv(), "a1");
    expect(calls.filter((c) => c.url.includes("atlassian"))).toHaveLength(0);
    expect(askRow().tracker_ref).toBeNull();
  });
  it("swallows tracker errors", async () => {
    insertAsk();
    vi.stubGlobal("fetch", async () => new Response("boom", { status: 500 }));
    await expect(syncTracker(jiraEnv(), "a1")).resolves.toBeUndefined();
    expect(askRow().tracker_ref).toBeNull();
  });
});

describe("jira", () => {
  it("creates the issue once, links it without touching updated_at, assigns by email", async () => {
    insertAsk();
    await syncTracker(jiraEnv(), "a1");
    const create = calls.find((c) => c.url.endsWith("/rest/api/3/issue"))!;
    expect(create.method).toBe("POST");
    expect(create.body.fields).toMatchObject({
      project: { key: "PLT" },
      summary: "Ship the report",
      duedate: "2026-11-05",
      assignee: { accountId: "acc-own" },
    });
    const adf = JSON.stringify(create.body.fields.description);
    expect(adf).toContain("Quarterly numbers");
    expect(adf).toContain("Name U_REQ");
    expect(adf).toContain("Name U_OWN");
    expect(adf).toContain("https://slack.test/archives/C1/p1");
    expect(askRow()).toMatchObject({ tracker_ref: "jira:PLT-12", tracker_url: "https://atlassian.test/browse/PLT-12", updated_at: 1 });
    expect((calls[0]!.body as any) && calls.find((c) => c.url.includes("atlassian"))!.method).toBeTruthy();

    // redelivery: no second create, nothing else to do
    const before = calls.length;
    await syncTracker(jiraEnv(), "a1");
    expect(calls.filter((c) => c.url.endsWith("/rest/api/3/issue"))).toHaveLength(1);
    expect(calls.slice(before).filter((c) => c.url.includes("atlassian"))).toHaveLength(0);
  });

  it("mirrors the lifecycle idempotently", async () => {
    insertAsk();
    const env = jiraEnv();
    await syncTracker(env, "a1");
    const jira = () => calls.filter((c) => c.url.includes("atlassian.test") && c.method !== "GET" && !c.url.endsWith("/rest/api/3/issue"));
    const mark = () => (calls = []);

    mark();
    setAsk({ state: "in_progress" });
    await syncTracker(env, "a1");
    await syncTracker(env, "a1");
    expect(jira().map((c) => [c.url.split("3/issue/")[1], c.body])).toEqual([["PLT-12/transitions", { transition: { id: "21" } }]]);

    mark();
    setAsk({ deadline_at: Date.UTC(2026, 11, 1) });
    await syncTracker(env, "a1");
    await syncTracker(env, "a1");
    expect(jira().map((c) => [c.method, c.body])).toEqual([["PUT", { fields: { duedate: "2026-12-01" } }]]);

    mark();
    setAsk({ state: "delivered", last_note: "all done", done_link: "https://docs/x" });
    await syncTracker(env, "a1");
    await syncTracker(env, "a1");
    expect(jira()).toHaveLength(1);
    expect(JSON.stringify(jira()[0]!.body)).toContain("https://docs/x");
    expect(jira()[0]!.url).toContain("/comment");

    mark();
    setAsk({ state: "accepted", last_note: "missing chart" }); // put back
    await syncTracker(env, "a1");
    await syncTracker(env, "a1");
    expect(jira().map((c) => c.url.split("3/issue/")[1])).toEqual(["PLT-12/comment", "PLT-12/transitions"]);
    expect(JSON.stringify(jira()[0]!.body)).toContain("Put back by Name U_REQ: missing chart");
    expect(jira()[1]!.body).toEqual({ transition: { id: "11" } });

    mark();
    setAsk({ state: "rejected", last_note: "no capacity" });
    await syncTracker(env, "a1");
    expect(JSON.stringify(jira()[0]!.body)).toContain("Rejected by Name U_OWN: no capacity");

    mark();
    setAsk({ state: "clarify", last_note: "which quarter?" });
    await syncTracker(env, "a1");
    expect(JSON.stringify(jira()[0]!.body)).toContain("which quarter?");

    mark();
    setAsk({ state: "closed" });
    await syncTracker(env, "a1");
    expect(jira().map((c) => c.body)).toEqual([{ transition: { id: "31" } }]);
  });

  it("redirect reassigns and comments", async () => {
    insertAsk();
    slackEmails.U_NEW = "new@x.com";
    jiraUsers["new@x.com"] = "acc-new";
    const env = jiraEnv();
    await syncTracker(env, "a1");
    calls = [];
    setAsk({ owner_id: "U_NEW", holder_id: "U_NEW", state: "proposed" });
    await syncTracker(env, "a1");
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toEqual({ fields: { assignee: { accountId: "acc-new" } } });
    expect(JSON.stringify(calls.find((c) => c.url.endsWith("/comment"))!.body)).toContain("Reassigned to Name U_NEW");
  });

  it("withdrawn uses a cancel transition, else comments", async () => {
    insertAsk();
    const env = jiraEnv();
    await syncTracker(env, "a1");
    calls = [];
    setAsk({ state: "withdrawn" });
    await syncTracker(env, "a1");
    expect(calls.find((c) => c.method === "POST" && c.url.includes("atlassian"))!.body).toEqual({ transition: { id: "41" } });

    // no cancel transition available
    fake = makeDb();
    insertAsk();
    jiraTransitions = JIRA_TRANSITIONS.slice(0, 3);
    const env2 = jiraEnv();
    await syncTracker(env2, "a1");
    calls = [];
    setAsk({ state: "withdrawn", last_note: "not needed" });
    await syncTracker(env2, "a1");
    const posts = calls.filter((c) => c.method === "POST" && c.url.includes("atlassian"));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toContain("/comment");
    expect(JSON.stringify(posts[0]!.body)).toContain("Withdrawn");
  });

  it("leaves an unmapped owner unassigned and says so in the description", async () => {
    insertAsk();
    slackEmails.U_OWN = "ghost@x.com";
    await syncTracker(jiraEnv(), "a1");
    const create = calls.find((c) => c.url.endsWith("/rest/api/3/issue"))!;
    expect(create.body.fields.assignee).toBeUndefined();
    expect(askRow().tracker_ref).toBe("jira:PLT-12");
  });

  it("also copes when Slack gives no email", async () => {
    insertAsk();
    slackEmails.U_OWN = null;
    await syncTracker(jiraEnv(), "a1");
    expect(calls.some((c) => c.url.includes("/user/search"))).toBe(false);
    expect(JSON.stringify(calls.find((c) => c.url.endsWith("/rest/api/3/issue"))!.body)).toContain("left unassigned");
  });

  it("writes the deadline as a calendar date in the owner's timezone", async () => {
    insertAsk({ deadline_at: Date.UTC(2026, 10, 5, 3, 0) }); // Nov 4 19:00 in Los Angeles
    slackTz.U_OWN = "America/Los_Angeles";
    const env = jiraEnv();
    await syncTracker(env, "a1");
    expect(calls.find((c) => c.url.endsWith("/rest/api/3/issue"))!.body.fields.duedate).toBe("2026-11-04");
    calls = [];
    setAsk({ deadline_at: Date.UTC(2026, 10, 5, 20, 0) });
    slackTz.U_OWN = "Pacific/Auckland"; // Nov 6 09:00 in Auckland
    await syncTracker(env, "a1");
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ fields: { duedate: "2026-11-06" } });
    expect(isoDate(Date.UTC(2026, 10, 5, 3, 0), "Not/AZone")).toBe("2026-11-05"); // invalid tz falls back to UTC
  });

  it("only one of two concurrent first syncs creates the issue", async () => {
    insertAsk();
    const env = jiraEnv();
    await Promise.all([syncTracker(env, "a1"), syncTracker(env, "a1")]);
    expect(calls.filter((c) => c.url.endsWith("/rest/api/3/issue"))).toHaveLength(1);
    expect(askRow().tracker_ref).toBe("jira:PLT-12");
    expect(fake.all("SELECT creating_at FROM tracker_sync")[0]!.creating_at).toBeNull();
  });

  it("a fresh claim blocks creation, a stale one (crashed create) is retaken, a failed create releases", async () => {
    insertAsk();
    const env = jiraEnv();
    fake.sqlite.prepare("INSERT INTO tracker_sync (ask_id, updated_at, creating_at) VALUES ('a1', 1, ?)").run(Date.now() - 30_000);
    await syncTracker(env, "a1");
    expect(calls.filter((c) => c.url.endsWith("/rest/api/3/issue"))).toHaveLength(0);
    fake.sqlite.prepare("UPDATE tracker_sync SET creating_at = ?").run(Date.now() - 3 * 60_000);
    await syncTracker(env, "a1");
    expect(calls.filter((c) => c.url.endsWith("/rest/api/3/issue"))).toHaveLength(1);

    fake = makeDb();
    insertAsk();
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) =>
      url.endsWith("/rest/api/3/issue") ? new Response("down", { status: 503 }) : real(url, init),
    );
    await syncTracker(jiraEnv(), "a1");
    expect(fake.all("SELECT creating_at FROM tracker_sync")[0]!.creating_at).toBeNull();
  });

  it("uses JIRA_ISSUE_TYPE when set", async () => {
    insertAsk();
    await syncTracker(jiraEnv({ JIRA_ISSUE_TYPE: "Story" }), "a1");
    expect(calls.find((c) => c.url.endsWith("/rest/api/3/issue"))!.body.fields.issuetype).toEqual({ name: "Story" });
  });

  it("does not guess among prefix matches whose email is hidden", async () => {
    insertAsk();
    vi.stubGlobal("fetch", ((real) => async (url: string, init: RequestInit) =>
      url.includes("/user/search")
        ? json([{ accountId: "a", accountType: "atlassian" }, { accountId: "b", accountType: "atlassian" }])
        : real(url, init))(globalThis.fetch));
    await syncTracker(jiraEnv(), "a1");
    expect(calls.find((c) => c.url.endsWith("/rest/api/3/issue"))!.body.fields.assignee).toBeUndefined();
  });

  it("resumes at the failed step", async () => {
    insertAsk({ state: "in_progress" });
    const env = jiraEnv();
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) =>
      url.endsWith("/transitions") && init?.method === "GET" ? new Response("down", { status: 503 }) : real(url, init),
    );
    await syncTracker(env, "a1");
    expect(askRow().tracker_ref).toBe("jira:PLT-12");
    expect(fake.all("SELECT state FROM tracker_sync")[0]!.state).toBeNull();
    vi.stubGlobal("fetch", real);
    calls = [];
    await syncTracker(env, "a1");
    expect(calls.find((c) => c.method === "POST" && c.url.includes("atlassian"))!.body).toEqual({ transition: { id: "21" } });
    expect(calls.filter((c) => c.url.endsWith("/rest/api/3/issue"))).toHaveLength(0);
  });
});

describe("linear", () => {
  const gql = () => calls.filter((c) => c.url === "https://linear.test/graphql");
  const mutations = () => gql().filter((c) => /mutation/.test(c.body.query));

  it("creates once with documented shapes and stores ref|identifier", async () => {
    insertAsk();
    const env = linearEnv();
    await syncTracker(env, "a1");
    await syncTracker(env, "a1");
    const creates = mutations().filter((c) => c.body.query.includes("issueCreate"));
    expect(creates).toHaveLength(1);
    expect(creates[0]!.body.variables.input).toMatchObject({
      teamId: "team1", title: "Ship the report", dueDate: "2026-11-05", assigneeId: "lin-own",
    });
    expect(creates[0]!.body.variables.input.description).toContain("[Slack source](https://slack.test/archives/C1/p1)");
    expect(gql()[0]!.url).toBe("https://linear.test/graphql");
    expect(askRow()).toMatchObject({ tracker_ref: "linear:lin-uuid|ENG-34", tracker_url: "https://linear.app/x/issue/ENG-34", updated_at: 1 });
    expect(mutations()).toHaveLength(1); // accepted: nothing more to mirror
  });

  it("maps states by type and handles cancel / done", async () => {
    insertAsk();
    const env = linearEnv();
    await syncTracker(env, "a1");
    calls = [];
    setAsk({ state: "in_progress" });
    await syncTracker(env, "a1");
    expect(mutations()[0]!.body.variables).toEqual({ id: "lin-uuid", input: { stateId: "s-doing" } });

    calls = [];
    setAsk({ state: "closed" });
    await syncTracker(env, "a1");
    expect(mutations()[0]!.body.variables.input).toEqual({ stateId: "s-done" });

    calls = [];
    setAsk({ state: "withdrawn" });
    await syncTracker(env, "a1");
    expect(mutations()[0]!.body.variables.input).toEqual({ stateId: "s-cancel" });
  });

  it("clears the due date and handles an unmapped owner", async () => {
    insertAsk();
    linearUsers = {};
    const env = linearEnv();
    await syncTracker(env, "a1");
    const create = mutations()[0]!;
    expect(create.body.variables.input.assigneeId).toBeUndefined();
    calls = [];
    setAsk({ deadline_at: null });
    await syncTracker(env, "a1");
    expect(mutations()[0]!.body.variables.input).toEqual({ dueDate: null });
  });

  it("comments on delivery", async () => {
    insertAsk();
    const env = linearEnv();
    await syncTracker(env, "a1");
    calls = [];
    setAsk({ state: "delivered", last_note: "shipped", done_link: "https://x/y" });
    await syncTracker(env, "a1");
    await syncTracker(env, "a1");
    expect(mutations()).toHaveLength(1);
    expect(mutations()[0]!.body.variables.input).toMatchObject({ issueId: "lin-uuid" });
    expect(mutations()[0]!.body.variables.input.body).toContain("https://x/y");
  });
});

describe("describe (pure)", () => {
  const ask = { size: "days", urgency: "urgent", detail: null, estimate_reason: null, deadline_at: null, source_permalink: null } as AskRow;
  it("builds a minimal description", () => {
    const d = buildDescription(ask, { requester: "R", owner: "O" });
    expect(d.map((p) => p.text)).toEqual(["Requester: R", "Owner: O", "Size: few days | Urgency: urgent"]);
  });
  it("plans nothing when already in sync", () => {
    const a = { ...ask, state: "accepted", owner_id: "O" } as AskRow;
    expect(planSync(a, { state: "accepted", deadline_at: null, owner_id: "O" }, { requester: "R", owner: "O" })).toEqual([]);
  });
});
