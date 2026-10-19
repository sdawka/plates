// Fakes for the issue trackers, written from the vendors' docs:
//  - Jira Cloud REST v3: POST /issue -> 201 {id,key,self}; PUT /issue/{key} -> 204; GET /issue/{key}/transitions ->
//    {transitions:[{id,name,to:{name,statusCategory:{key}}}]}; POST .../transitions -> 204; POST .../comment (ADF body)
//    -> 201; GET /user/search?query= -> [{accountId,accountType,displayName,emailAddress?}]. Errors are
//    {errorMessages:[], errors:{field:msg}} with 400/401/404. Basic auth (email:api_token).
//  - Linear GraphQL (POST, `Authorization: <personal api key>` without "Bearer"): data/errors envelope.
import { json, type Network } from "./net";

type Obj = Record<string, unknown>;

export const JIRA_URL = "https://jira.test";
export const JIRA_EMAIL = "bot@plates.test";
export const JIRA_TOKEN = "jira-api-token";
export const JIRA_PROJECT = "PLT";
export const LINEAR_URL = "https://linear.test/graphql";
export const LINEAR_KEY = "lin_api_testkey";
export const LINEAR_TEAM = "team-uuid-1";

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string; // absent when the user hides it
  accountType?: string;
}
export interface JiraIssue {
  id: string;
  key: string;
  fields: { summary: string; description: Obj | null; duedate: string | null; assignee: { accountId: string } | null; issuetype: string; project: string };
  status: string;
  comments: { id: string; body: Obj }[];
}
interface Status {
  name: string;
  category: "new" | "indeterminate" | "done";
}

const jsonErr = (status: number, errorMessages: string[], errors: Obj = {}) => json({ errorMessages, errors }, status);

const adfValid = (d: unknown): boolean => {
  const o = d as { type?: string; version?: number; content?: unknown[] } | null;
  return !!o && typeof o === "object" && o.type === "doc" && o.version === 1 && Array.isArray(o.content);
};

export class FakeJira {
  readonly issues = new Map<string, JiraIssue>();
  readonly users: JiraUser[] = [];
  /** Every request, in order: "POST /issue", "PUT /issue/PLT-1" ... */
  readonly log: string[] = [];
  statuses: Status[] = [
    { name: "To Do", category: "new" },
    { name: "In Progress", category: "indeterminate" },
    { name: "Done", category: "done" },
  ];
  /** Fail the next N requests matching `pattern` with `status`. */
  private failures: { pattern: RegExp; status: number; times: number }[] = [];
  /** When set, POST /issue waits for this promise (to force overlapping creates). */
  createGate: Promise<void> | null = null;
  private n = 10000;

  constructor(private now: () => number) {}

  addUser(u: JiraUser): void {
    this.users.push({ accountType: "atlassian", ...u });
  }

  fail(pattern: RegExp, status = 500, times = 1): void {
    this.failures.push({ pattern, status, times });
  }

  hold(): () => void {
    let release!: () => void;
    this.createGate = new Promise<void>((r) => (release = r));
    return () => {
      release();
      this.createGate = null;
    };
  }

  creates(): number {
    return this.log.filter((l) => l === "POST /issue").length;
  }

  attach(net: Network): void {
    net.route(`${JIRA_URL}/`, (req) => this.handle(req));
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/rest\/api\/3/, "");
    const label = `${req.method} ${path}`;
    this.log.push(label);
    if (req.headers.get("authorization") !== `Basic ${btoa(`${JIRA_EMAIL}:${JIRA_TOKEN}`)}`) return jsonErr(401, ["You are not authenticated. Authentication required to perform this operation."]);
    const fail = this.failures.find((f) => f.times > 0 && f.pattern.test(label));
    if (fail) {
      fail.times--;
      return jsonErr(fail.status, ["Injected failure"]);
    }
    const raw = req.method === "GET" ? "" : await req.text();
    const body = raw ? (JSON.parse(raw) as Obj) : null;
    if (body !== null && !(req.headers.get("content-type") ?? "").includes("application/json")) return jsonErr(415, ["Content-Type must be application/json"]);

    if (req.method === "GET" && path === "/user/search") {
      const q = (url.searchParams.get("query") ?? "").toLowerCase();
      if (!q) return jsonErr(400, ["The query parameter 'query' is not provided"]);
      const hits = this.users.filter((u) => u.displayName.toLowerCase().startsWith(q) || (u.emailAddress ?? "").toLowerCase().startsWith(q));
      return json(hits.map((u) => ({ self: `${JIRA_URL}/rest/api/3/user?accountId=${u.accountId}`, accountId: u.accountId, accountType: u.accountType, displayName: u.displayName, active: true, ...(u.emailAddress ? { emailAddress: u.emailAddress } : {}) })));
    }
    if (req.method === "POST" && path === "/issue") return this.create(body ?? {});

    const m = /^\/issue\/([A-Z][A-Z0-9]*-\d+)(\/transitions|\/comment)?$/.exec(path);
    if (!m) return jsonErr(404, ["No route"]);
    const issue = this.issues.get(m[1]!);
    if (!issue) return jsonErr(404, ["Issue does not exist or you do not have permission to see it."]);
    if (m[2] === "/transitions") return req.method === "GET" ? this.transitions(issue) : this.transition(issue, body ?? {});
    if (m[2] === "/comment" && req.method === "POST") return this.comment(issue, body ?? {});
    if (!m[2] && req.method === "PUT") return this.edit(issue, body ?? {});
    return jsonErr(405, ["Method not allowed"]);
  }

  private async create(body: Obj): Promise<Response> {
    const f = (body.fields ?? {}) as Obj;
    const errors: Obj = {};
    if (!(f.project as Obj | undefined)?.key && !(f.project as Obj | undefined)?.id) errors.project = "project is required";
    else if ((f.project as Obj).key !== JIRA_PROJECT) errors.project = "project is required";
    if (!(f.issuetype as Obj | undefined)?.name && !(f.issuetype as Obj | undefined)?.id) errors.issuetype = "issue type is required";
    if (typeof f.summary !== "string" || !f.summary.trim()) errors.summary = "You must specify a summary of the issue.";
    else if (f.summary.length > 255) errors.summary = "Summary must be less than 255 characters.";
    if (f.description !== undefined && f.description !== null && !adfValid(f.description)) errors.description = "Operation value must be an Atlassian Document (see the Atlassian Document Format)";
    if (f.duedate !== undefined && f.duedate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(f.duedate))) errors.duedate = "Error parsing date string: " + String(f.duedate);
    if (f.assignee && !this.users.some((u) => u.accountId === (f.assignee as Obj).accountId)) errors.assignee = "User '" + String((f.assignee as Obj).accountId) + "' does not exist.";
    for (const k of Object.keys(f)) if (!["project", "issuetype", "summary", "description", "duedate", "assignee", "labels", "priority"].includes(k)) errors[k] = `Field '${k}' cannot be set. It is not on the appropriate screen, or unknown.`;
    if (Object.keys(errors).length) return jsonErr(400, [], errors);
    if (this.createGate) await this.createGate;
    const id = String(++this.n);
    const key = `${JIRA_PROJECT}-${this.issues.size + 1}`;
    this.issues.set(key, {
      id, key,
      fields: { summary: f.summary as string, description: (f.description as Obj | undefined) ?? null, duedate: (f.duedate as string | undefined) ?? null, assignee: (f.assignee as { accountId: string } | undefined) ?? null, issuetype: String((f.issuetype as Obj).name ?? (f.issuetype as Obj).id), project: JIRA_PROJECT },
      status: this.statuses[0]!.name,
      comments: [],
    });
    return json({ id, key, self: `${JIRA_URL}/rest/api/3/issue/${id}` }, 201);
  }

  private edit(issue: JiraIssue, body: Obj): Response {
    const f = (body.fields ?? {}) as Obj;
    const errors: Obj = {};
    for (const k of Object.keys(f)) if (!["duedate", "assignee", "summary", "description", "labels"].includes(k)) errors[k] = `Field '${k}' cannot be set. It is not on the appropriate screen, or unknown.`;
    if ("duedate" in f && f.duedate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(f.duedate))) errors.duedate = "Error parsing date string: " + String(f.duedate);
    if ("assignee" in f && f.assignee !== null && !this.users.some((u) => u.accountId === (f.assignee as Obj)?.accountId)) errors.assignee = "User does not exist.";
    if (Object.keys(errors).length) return jsonErr(400, [], errors);
    if ("duedate" in f) issue.fields.duedate = f.duedate as string | null;
    if ("assignee" in f) issue.fields.assignee = f.assignee as { accountId: string } | null;
    if ("summary" in f) issue.fields.summary = String(f.summary);
    return new Response(null, { status: 204 });
  }

  private transitions(issue: JiraIssue): Response {
    const list = this.statuses
      .filter((s) => s.name !== issue.status)
      .map((s) => ({
        id: String(11 + this.statuses.indexOf(s)),
        name: s.name,
        to: { self: `${JIRA_URL}/rest/api/3/status/${this.statuses.indexOf(s)}`, description: "", id: String(this.statuses.indexOf(s)), name: s.name, statusCategory: { id: 1, key: s.category, colorName: "blue-gray", name: s.name } },
        hasScreen: false, isGlobal: true, isInitial: false, isAvailable: true, isConditional: false, isLooped: false,
      }));
    return json({ expand: "transitions", transitions: list });
  }

  private transition(issue: JiraIssue, body: Obj): Response {
    const id = String((body.transition as Obj | undefined)?.id ?? "");
    const to = this.statuses.find((s) => String(11 + this.statuses.indexOf(s)) === id && s.name !== issue.status);
    if (!to) return jsonErr(400, [`Transition id '${id}' is not valid for this issue.`]);
    issue.status = to.name;
    return new Response(null, { status: 204 });
  }

  private comment(issue: JiraIssue, body: Obj): Response {
    if (!adfValid(body.body)) return jsonErr(400, ["Comment body is not valid!"]);
    const c = { id: String(++this.n), body: body.body as Obj };
    issue.comments.push(c);
    return json({ id: c.id, self: `${JIRA_URL}/rest/api/3/issue/${issue.id}/comment/${c.id}`, body: c.body, created: new Date(this.now()).toISOString(), updated: new Date(this.now()).toISOString() }, 201);
  }
}

// ---------- Linear ----------

export interface LinearIssue {
  id: string;
  identifier: string;
  url: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  assigneeId: string | null;
  stateId: string;
  comments: string[];
}

export class FakeLinear {
  readonly issues = new Map<string, LinearIssue>();
  readonly users: { id: string; email: string }[] = [];
  readonly states = [
    { id: "st-backlog", name: "Backlog", type: "backlog", position: 0 },
    { id: "st-todo", name: "Todo", type: "unstarted", position: 1 },
    { id: "st-doing", name: "In Progress", type: "started", position: 2 },
    { id: "st-done", name: "Done", type: "completed", position: 3 },
    { id: "st-cancel", name: "Canceled", type: "canceled", position: 4 },
  ];
  readonly log: string[] = [];
  createGate: Promise<void> | null = null;
  private n = 0;

  addUser(u: { id: string; email: string }): void {
    this.users.push(u);
  }

  hold(): () => void {
    let release!: () => void;
    this.createGate = new Promise<void>((r) => (release = r));
    return () => {
      release();
      this.createGate = null;
    };
  }

  creates(): number {
    return this.log.filter((l) => l === "issueCreate").length;
  }

  attach(net: Network): void {
    net.route(LINEAR_URL, (req) => this.handle(req));
  }

  private gqlErr(message: string, code = "INVALID_INPUT") {
    return json({ errors: [{ message, extensions: { type: "invalid input", code, userPresentableMessage: message } }], data: null });
  }

  private async handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return json({ errors: [{ message: "Only POST is supported" }] }, 405);
    const auth = req.headers.get("authorization") ?? "";
    // Personal API keys go in as-is; "Bearer <key>" is only valid for OAuth tokens.
    if (auth !== LINEAR_KEY) return json({ errors: [{ message: "Authentication required, not authenticated", extensions: { type: "authentication error", code: "AUTHENTICATION_ERROR" } }] }, 400);
    if (!(req.headers.get("content-type") ?? "").includes("application/json")) return json({ errors: [{ message: "Content-Type must be application/json" }] }, 400);
    const body = (await req.json()) as { query?: string; variables?: Obj };
    const q = body.query ?? "";
    const v = body.variables ?? {};
    if (!q.trim()) return json({ errors: [{ message: "Must provide query string." }] }, 400);

    if (/\busers\s*\(/.test(q)) {
      this.log.push("users");
      const email = ((v.email as string | undefined) ?? "").toLowerCase();
      return json({ data: { users: { nodes: this.users.filter((u) => u.email.toLowerCase() === email).map((u) => ({ id: u.id })) } } });
    }
    if (/\bteam\s*\(/.test(q)) {
      this.log.push("team");
      if (v.id !== LINEAR_TEAM) return this.gqlErr("Entity not found: Team", "INVALID_INPUT");
      return json({ data: { team: { states: { nodes: this.states } } } });
    }
    if (/\bissueCreate\s*\(/.test(q)) {
      this.log.push("issueCreate");
      const input = (v.input ?? {}) as Obj;
      if (input.teamId !== LINEAR_TEAM) return this.gqlErr("teamId must be a UUID of an existing team");
      if (typeof input.title !== "string" || !input.title) return this.gqlErr("title must be a string");
      if (input.dueDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(input.dueDate))) return this.gqlErr("dueDate must be a TimelessDate (YYYY-MM-DD)");
      if (input.assigneeId && !this.users.some((u) => u.id === input.assigneeId)) return this.gqlErr("assigneeId: Entity not found: User");
      if (this.createGate) await this.createGate;
      const n = ++this.n;
      const issue: LinearIssue = {
        id: `issue-uuid-${n}`, identifier: `ENG-${n}`, url: `https://linear.app/plates/issue/ENG-${n}`,
        title: input.title, description: (input.description as string | undefined) ?? null, dueDate: (input.dueDate as string | undefined) ?? null,
        assigneeId: (input.assigneeId as string | undefined) ?? null, stateId: this.states[1]!.id, comments: [],
      };
      this.issues.set(issue.id, issue);
      return json({ data: { issueCreate: { success: true, issue: { id: issue.id, identifier: issue.identifier, url: issue.url } } } });
    }
    if (/\bissueUpdate\s*\(/.test(q)) {
      this.log.push("issueUpdate");
      const issue = this.issues.get(String(v.id));
      if (!issue) return this.gqlErr("Entity not found: Issue", "INVALID_INPUT");
      const input = (v.input ?? {}) as Obj;
      if ("dueDate" in input && input.dueDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(input.dueDate))) return this.gqlErr("dueDate must be a TimelessDate (YYYY-MM-DD)");
      if ("stateId" in input && !this.states.some((s) => s.id === input.stateId)) return this.gqlErr("stateId: Entity not found: WorkflowState");
      if ("assigneeId" in input && input.assigneeId !== null && !this.users.some((u) => u.id === input.assigneeId)) return this.gqlErr("assigneeId: Entity not found: User");
      if ("dueDate" in input) issue.dueDate = input.dueDate as string | null;
      if ("assigneeId" in input) issue.assigneeId = input.assigneeId as string | null;
      if ("stateId" in input) issue.stateId = input.stateId as string;
      return json({ data: { issueUpdate: { success: true } } });
    }
    if (/\bcommentCreate\s*\(/.test(q)) {
      this.log.push("commentCreate");
      const input = (v.input ?? {}) as Obj;
      const issue = this.issues.get(String(input.issueId));
      if (!issue) return this.gqlErr("Entity not found: Issue");
      if (typeof input.body !== "string" || !input.body) return this.gqlErr("body must be a string");
      issue.comments.push(input.body);
      return json({ data: { commentCreate: { success: true } } });
    }
    return json({ errors: [{ message: `Cannot query field in "${q.slice(0, 40)}"`, extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] }, 400);
  }
}

export class FakeTrackers {
  readonly jira: FakeJira;
  readonly linear = new FakeLinear();
  constructor(now: () => number) {
    this.jira = new FakeJira(now);
  }
  attach(net: Network): void {
    this.jira.attach(net);
    this.linear.attach(net);
  }
}

export const JIRA_ENV = { TRACKER: "jira", JIRA_BASE_URL: JIRA_URL, JIRA_EMAIL, JIRA_API_TOKEN: JIRA_TOKEN, JIRA_PROJECT_KEY: JIRA_PROJECT } as const;
export const LINEAR_ENV = { TRACKER: "linear", LINEAR_API_KEY: LINEAR_KEY, LINEAR_TEAM_ID: LINEAR_TEAM, LINEAR_API_URL: LINEAR_URL } as const;
