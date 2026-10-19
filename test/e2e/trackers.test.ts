import { afterEach, describe, expect, it } from "vitest";
import { CHANNEL, USERS, createHarness, type Harness } from "../helpers/env";
import { JIRA_ENV, JIRA_URL, LINEAR_ENV, type JiraIssue } from "../helpers/fakeTrackers";
import { tagAndConfirm } from "../helpers/scenario";
import { syncTracker } from "../../src/trackers";

let h: Harness;
afterEach(() => h.dispose());

const users = [
  { id: USERS.dana, name: "dana", real_name: "Dana Reed", tz: "America/New_York", email: "dana@corp.test" },
  { id: USERS.bob, name: "bob", real_name: "Bob Ortiz", tz: "America/New_York", email: "bob@corp.test" },
  { id: USERS.tara, name: "tara", real_name: "Tara Lin" },
  { id: USERS.eve, name: "eve", real_name: "Eve Park", email: "eve@corp.test" },
];
const ask = () => h.asks()[0]!;
const dmRef = (u: string) => ({ channel: h.slack.im(u).id, ts: h.slack.im(u).messages.at(-1)!.ts });
const adfText = (d: unknown): string => JSON.stringify(d).match(/"text":"((?:[^"\\]|\\.)*)"/g)!.map((m) => JSON.parse(`{${m}}`).text).join("\n");
const issue = (key = "PLT-1"): JiraIssue => h.trackers.jira.issues.get(key)!;

function jira(opts: { cancel?: boolean } = {}) {
  h = createHarness({ users, env: { ...JIRA_ENV } });
  h.trackers.jira.addUser({ accountId: "acc-bob", displayName: "Bob Ortiz", emailAddress: "bob@corp.test" });
  h.trackers.jira.addUser({ accountId: "acc-eve", displayName: "Eve Park", emailAddress: "eve@corp.test" });
  h.trackers.jira.addUser({ accountId: "acc-bot", displayName: "Automation", accountType: "app" });
  if (opts.cancel) h.trackers.jira.statuses.push({ name: "Cancelled", category: "done" });
}

describe("Jira Cloud v3", () => {
  it("accepting creates one issue: ADF description, assignee from the Slack email, transitioned to In Progress", async () => {
    jira();
    await tagAndConfirm(h);
    expect(h.trackers.jira.creates()).toBe(0); // proposed asks are not mirrored
    await h.click(USERS.bob, dmRef(USERS.bob), "ask:accept_now", ask().id as string);

    expect(h.trackers.jira.creates()).toBe(1);
    const i = issue();
    expect(i.fields).toMatchObject({ summary: "Send the Q3 numbers", project: "PLT", issuetype: "Task", duedate: null, assignee: { accountId: "acc-bob" } });
    expect(i.fields.description).toMatchObject({ type: "doc", version: 1 });
    const body = adfText(i.fields.description);
    expect(body).toContain("Requester: Dana Reed");
    expect(body).toContain("Owner: Bob Ortiz");
    expect(i.status).toBe("In Progress");
    expect(ask()).toMatchObject({ tracker_ref: "jira:PLT-1", tracker_url: `${JIRA_URL}/browse/PLT-1` });
    expect(h.q("SELECT state, owner_id FROM tracker_sync")).toEqual([{ state: "in_progress", owner_id: USERS.bob }]);
    expect(h.errors).toEqual([]);
  });

  it("a deadline becomes duedate in the owner's time zone; moving it updates the issue", async () => {
    jira();
    const t = await tagAndConfirm(h);
    const id = ask().id as string;
    await h.click(USERS.bob, dmRef(USERS.bob), "ask:accept_later", id);
    await h.submit(USERS.bob, { date: "2026-10-22" });
    expect(issue().fields.duedate).toBe("2026-10-22");
    expect(issue().status).toBe("To Do"); // accepted for later: not started

    await h.choose(USERS.bob, { channel: CHANNEL, ts: t.card.ts }, "ask:overflow", `ask:set_deadline|${id}`);
    await h.submit(USERS.bob, { date: "2026-10-26" });
    expect(issue().fields.duedate).toBe("2026-10-26");
    expect(h.trackers.jira.creates()).toBe(1);
    expect(h.errors).toEqual([]);
  });

  it("delivery comments, close transitions to Done, and re-syncing is a no-op", async () => {
    jira();
    await tagAndConfirm(h);
    const id = ask().id as string;
    await h.click(USERS.bob, dmRef(USERS.bob), "ask:accept_now", id);
    await h.click(USERS.bob, dmRef(USERS.bob), "ask:done", id);
    await h.submit(USERS.bob, { link: "https://docs.test/q3", note: "numbers attached" });
    expect(issue().comments).toHaveLength(1);
    expect(adfText(issue().comments[0]!.body)).toContain("Delivered by Bob Ortiz.");
    expect(adfText(issue().comments[0]!.body)).toContain("https://docs.test/q3");
    expect(issue().status).toBe("In Progress");

    await h.click(USERS.dana, dmRef(USERS.dana), "ask:close", id);
    expect(issue().status).toBe("Done");
    expect(ask().state).toBe("closed");

    const writes = () => h.trackers.jira.log.filter((l) => !l.startsWith("GET")).length;
    const before = writes();
    await syncTracker(h.env, id);
    await syncTracker(h.env, id);
    expect(writes()).toBe(before);
    expect(h.trackers.jira.creates()).toBe(1);
  });

  const withdraw = async (note?: string) => {
    const id = ask().id as string;
    await h.click(USERS.bob, dmRef(USERS.bob), "ask:accept_now", id);
    await h.openHome(USERS.dana);
    await h.clickHome(USERS.dana, "ask:withdraw", id);
    await h.submit(USERS.dana, note ? { note } : {});
    expect(ask().state).toBe("withdrawn");
  };

  it("withdraw uses the workflow's cancel transition when there is one", async () => {
    jira({ cancel: true });
    await tagAndConfirm(h);
    await withdraw();
    expect(issue().status).toBe("Cancelled");
    expect(issue().comments).toEqual([]);
  });

  it("withdraw falls back to a comment when the workflow has no cancel transition", async () => {
    jira();
    await tagAndConfirm(h);
    await withdraw();
    expect(issue().status).toBe("In Progress");
    expect(issue().comments.map((c) => adfText(c.body))).toEqual(["Withdrawn by Dana Reed."]);
  });

  it("the reason typed when withdrawing reaches the tracker comment", async () => {
    jira();
    await tagAndConfirm(h);
    await withdraw("not needed anymore");
    expect(issue().comments.map((c) => adfText(c.body))).toEqual(["Withdrawn by Dana Reed: not needed anymore"]);
  });

  it("no duplicate issue when syncs run concurrently", async () => {
    jira();
    await tagAndConfirm(h);
    const id = ask().id as string;
    // make the ask eligible without going through the effect, then race two syncs while Jira is slow
    await h.env.DB.prepare("UPDATE asks SET state = 'in_progress' WHERE id = ?").bind(id).run();
    const release = h.trackers.jira.hold();
    const a = syncTracker(h.env, id);
    const b = syncTracker(h.env, id);
    const c = syncTracker(h.env, id);
    await new Promise((r) => setTimeout(r, 20));
    release();
    await Promise.all([a, b, c]);
    expect(h.trackers.jira.creates()).toBe(1);
    expect(h.trackers.jira.issues.size).toBe(1);
    expect(ask().tracker_ref).toBe("jira:PLT-1");
    expect(h.errors).toEqual([]);
  });

  it("a Jira outage on create leaves no half-state, and the next sync creates exactly one issue", async () => {
    jira();
    h.trackers.jira.fail(/^POST \/issue$/, 503, 1);
    await tagAndConfirm(h);
    const id = ask().id as string;
    await h.click(USERS.bob, dmRef(USERS.bob), "ask:accept_now", id);
    expect(h.trackers.jira.issues.size).toBe(0);
    expect(ask().tracker_ref).toBeNull();
    expect(h.errors.join("\n")).toContain("tracker sync failed");
    await syncTracker(h.env, id);
    expect(h.trackers.jira.issues.size).toBe(1);
    expect(issue().status).toBe("In Progress");
  });

  it("an owner without a Slack email is created unassigned and the description says so", async () => {
    jira();
    await tagAndConfirm(h, { owner: USERS.tara });
    await h.click(USERS.tara, dmRef(USERS.tara), "ask:accept_now", ask().id as string);
    expect(issue().fields.assignee).toBeNull();
    expect(adfText(issue().fields.description)).toContain("Owner: Tara Lin (no matching tracker user, left unassigned)");
    expect(h.trackers.jira.log.filter((l) => l.startsWith("GET /user/search"))).toEqual([]);
  });

  it("an owner whose email matches no Jira user is created unassigned, without failing", async () => {
    h = createHarness({ users, env: { ...JIRA_ENV } }); // no Jira users registered
    await tagAndConfirm(h);
    await h.click(USERS.bob, dmRef(USERS.bob), "ask:accept_now", ask().id as string);
    expect(issue().fields.assignee).toBeNull();
    expect(issue().status).toBe("In Progress");
    expect(h.errors).toEqual([]);
  });

  it("a lone Jira user who hides their email is trusted as the match; app accounts are ignored", async () => {
    h = createHarness({ users, env: { ...JIRA_ENV } });
    h.trackers.jira.addUser({ accountId: "acc-hidden", displayName: "bob@corp.test" });
    h.trackers.jira.addUser({ accountId: "acc-app", displayName: "bob@corp.test automation", accountType: "app" });
    await tagAndConfirm(h);
    await h.click(USERS.bob, dmRef(USERS.bob), "ask:accept_now", ask().id as string);
    expect(issue().fields.assignee).toEqual({ accountId: "acc-hidden" });
  });

  it("redirecting reassigns the issue and comments", async () => {
    jira();
    const t = await tagAndConfirm(h);
    const id = ask().id as string;
    await h.click(USERS.bob, dmRef(USERS.bob), "ask:accept_now", id);
    await h.choose(USERS.bob, { channel: CHANNEL, ts: t.card.ts }, "ask:overflow", `ask:redirect|${id}`);
    await h.submit(USERS.bob, { user: USERS.eve });
    expect(ask().owner_id).toBe(USERS.eve);
    expect(issue().fields.assignee).toEqual({ accountId: "acc-eve" });
    expect(issue().comments.map((c) => adfText(c.body))).toContain("Reassigned to Eve Park.");
    expect(h.trackers.jira.creates()).toBe(1);
  });

  it("only deliverables are mirrored", async () => {
    jira();
    await tagAndConfirm(h, { type: "info" });
    await h.click(USERS.bob, dmRef(USERS.bob), "ask:accept_now", ask().id as string);
    expect(h.trackers.jira.log).toEqual([]);
  });

  it("a wrong API token is logged and does not break the Slack action", async () => {
    h = createHarness({ users, env: { ...JIRA_ENV, JIRA_API_TOKEN: "wrong" } });
    await tagAndConfirm(h);
    const res = await h.click(USERS.bob, dmRef(USERS.bob), "ask:accept_now", ask().id as string);
    expect(res.status).toBe(200);
    expect(ask().state).toBe("in_progress");
    expect(ask().tracker_ref).toBeNull();
    expect(h.errors.join("\n")).toContain("HTTP 401");
  });
});

describe("Linear GraphQL", () => {
  function linear() {
    h = createHarness({ users, env: { ...LINEAR_ENV } });
    h.trackers.linear.addUser({ id: "lin-bob", email: "bob@corp.test" });
  }
  const lissue = (n = 1) => h.trackers.linear.issues.get(`issue-uuid-${n}`)!;
  const stateName = (i: { stateId: string }) => h.trackers.linear.states.find((s) => s.id === i.stateId)!.name;

  it("accept -> issue in the team, assigned by email, moved to the 'started' state", async () => {
    linear();
    await tagAndConfirm(h);
    await h.click(USERS.bob, dmRef(USERS.bob), "ask:accept_now", ask().id as string);
    expect(h.trackers.linear.creates()).toBe(1);
    expect(lissue()).toMatchObject({ title: "Send the Q3 numbers", assigneeId: "lin-bob", dueDate: null });
    expect(lissue().description).toContain("Requester: Dana Reed");
    expect(stateName(lissue())).toBe("In Progress");
    expect(ask()).toMatchObject({ tracker_ref: "linear:issue-uuid-1|ENG-1", tracker_url: "https://linear.app/plates/issue/ENG-1" });
    expect(h.errors).toEqual([]);
  });

  it("deadline, delivery comment, close -> Done; withdraw -> Canceled", async () => {
    linear();
    await tagAndConfirm(h);
    const id = ask().id as string;
    await h.click(USERS.bob, dmRef(USERS.bob), "ask:accept_later", id);
    await h.submit(USERS.bob, { date: "2026-10-22" });
    expect(lissue().dueDate).toBe("2026-10-22");
    expect(stateName(lissue())).toBe("Todo");
    await h.click(USERS.bob, dmRef(USERS.bob), "ask:done", id);
    await h.submit(USERS.bob, { link: "https://docs.test/q3" });
    expect(lissue().comments[0]).toContain("Delivered by Bob Ortiz.");
    await h.click(USERS.dana, dmRef(USERS.dana), "ask:close", id);
    expect(stateName(lissue())).toBe("Done");

    await tagAndConfirm(h, { titles: ["Second thing"] });
    const second = h.asks().find((a) => a.title === "Second thing")!;
    await h.click(USERS.bob, dmRef(USERS.bob), "ask:accept_now", second.id as string);
    await h.openHome(USERS.dana);
    await h.clickHome(USERS.dana, "ask:withdraw", second.id as string);
    await h.submit(USERS.dana, {});
    expect(stateName(lissue(2))).toBe("Canceled");
  });

  it("concurrent syncs create exactly one Linear issue", async () => {
    linear();
    await tagAndConfirm(h);
    const id = ask().id as string;
    await h.env.DB.prepare("UPDATE asks SET state = 'in_progress' WHERE id = ?").bind(id).run();
    const release = h.trackers.linear.hold();
    const all = [syncTracker(h.env, id), syncTracker(h.env, id), syncTracker(h.env, id)];
    await new Promise((r) => setTimeout(r, 20));
    release();
    await Promise.all(all);
    expect(h.trackers.linear.creates()).toBe(1);
    expect(h.trackers.linear.issues.size).toBe(1);
  });

  it("sends the personal API key as-is in Authorization (no Bearer) and GraphQL errors do not break the action", async () => {
    h = createHarness({ users, env: { ...LINEAR_ENV, LINEAR_API_KEY: "Bearer lin_api_testkey" } });
    await tagAndConfirm(h);
    const res = await h.click(USERS.bob, dmRef(USERS.bob), "ask:accept_now", ask().id as string);
    expect(res.status).toBe(200);
    expect(ask().state).toBe("in_progress");
    expect(h.trackers.linear.issues.size).toBe(0);
    expect(h.errors.join("\n")).toContain("tracker sync failed");
  });
});
