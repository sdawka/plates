// Jira Cloud REST API v3. https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/
// Shapes checked against https://dac-static.atlassian.com/cloud/jira/platform/swagger-v3.v3.json:
// user/search `query` matches displayName/emailAddress by prefix; emailAddress may be null (privacy);
// create -> 201 {id,key,self}; edit and transition -> 204; comment -> 201; transition.to is a StatusDetails.
//  - issues:       https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/
//  - user search:  https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-user-search/
//  - ADF document: https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
import type { Env } from "../types";
import type { Paragraph, StatusKind } from "./describe";
import { expectOk, TrackerError, type NewIssue, type Tracker } from "./types";

const CANCEL_RE = /cancel|won'?t|declin/i;

export function jiraFromEnv(env: Env): Tracker | null {
  const { JIRA_BASE_URL: base, JIRA_EMAIL: email, JIRA_API_TOKEN: token, JIRA_PROJECT_KEY: project } = env;
  if (!base || !email || !token || !project) return null;
  return new Jira(base.replace(/\/+$/, ""), `Basic ${btoa(`${email}:${token}`)}`, project, env.JIRA_ISSUE_TYPE || "Task");
}

const adfText = (text: string, href?: string) => ({
  type: "text",
  text,
  ...(href ? { marks: [{ type: "link", attrs: { href } }] } : {}),
});

export function adfParagraphs(ps: Paragraph[]) {
  return {
    type: "doc",
    version: 1,
    content: ps.map((p) => ({ type: "paragraph", content: [adfText(p.text, p.href)] })),
  };
}

export const adfFromText = (text: string) =>
  adfParagraphs(text.split("\n").map((line) => ({ text: line || " " })));

interface Transition {
  id: string;
  name: string;
  to: { name: string; statusCategory: { key: string } };
}

class Jira implements Tracker {
  constructor(private base: string, private auth: string, private project: string, private issueType: string) {}

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.base}/rest/api/3${path}`, {
      method,
      headers: {
        authorization: this.auth,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return expectOk(res, `jira ${method} ${path.split("?")[0]}`);
  }

  private key(ref: string): string {
    if (!ref.startsWith("jira:")) throw new TrackerError(`not a jira ref: ${ref}`);
    return ref.slice(5);
  }

  /** accountId for an email, or null. Needs the "Browse users and groups" permission. */
  private async accountId(email: string): Promise<string | null> {
    const users = (await this.call("GET", `/user/search?query=${encodeURIComponent(email)}`)) as {
      accountId: string;
      emailAddress?: string;
      accountType?: string;
    }[];
    const real = users.filter((u) => !u.accountType || u.accountType === "atlassian");
    const exact = real.find((u) => u.emailAddress?.toLowerCase() === email.toLowerCase());
    if (exact) return exact.accountId;
    // The query matches prefixes, and emailAddress is null for users who hide it: only trust a lone hit.
    const hidden = real.filter((u) => !u.emailAddress);
    return real.length === 1 && hidden.length === 1 ? hidden[0]!.accountId : null;
  }

  async createIssue(i: NewIssue) {
    const accountId = i.assigneeEmail ? await this.accountId(i.assigneeEmail) : null;
    const fields: Record<string, unknown> = {
      project: { key: this.project },
      issuetype: { name: this.issueType },
      summary: i.title,
      description: adfParagraphs(i.description),
    };
    if (i.dueDate) fields.duedate = i.dueDate;
    if (accountId) fields.assignee = { accountId };
    const r = (await this.call("POST", "/issue", { fields })) as { id: string; key: string; self: string };
    return { ref: `jira:${r.key}`, url: `${this.base}/browse/${r.key}`, assigned: !!accountId };
  }

  async setDueDate(ref: string, date: string | null) {
    await this.call("PUT", `/issue/${this.key(ref)}`, { fields: { duedate: date } });
  }

  async setAssignee(ref: string, email: string | null) {
    const accountId = email ? await this.accountId(email) : null;
    await this.call("PUT", `/issue/${this.key(ref)}`, { fields: { assignee: accountId ? { accountId } : null } });
    return !email || !!accountId;
  }

  async setStatus(ref: string, to: StatusKind) {
    const key = this.key(ref);
    const { transitions } = (await this.call("GET", `/issue/${key}/transitions`)) as { transitions: Transition[] };
    const isCancel = (t: Transition) => CANCEL_RE.test(t.name) || CANCEL_RE.test(t.to.name);
    const cat = (t: Transition) => t.to.statusCategory.key;
    const pick =
      to === "cancel"
        ? transitions.find(isCancel)
        : to === "done"
          ? (transitions.find((t) => cat(t) === "done" && !isCancel(t)) ?? undefined)
          : transitions.find((t) => cat(t) === (to === "doing" ? "indeterminate" : "new"));
    if (!pick) return false;
    await this.call("POST", `/issue/${key}/transitions`, { transition: { id: pick.id } });
    return true;
  }

  async comment(ref: string, text: string) {
    await this.call("POST", `/issue/${this.key(ref)}/comment`, { body: adfFromText(text) });
  }
}

