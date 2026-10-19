// Linear GraphQL API. https://developers.linear.app/docs/graphql/working-with-the-graphql-api
// Checked against https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql
// (UserFilter.email: StringComparator, Team.states(filter), IssueUpdate id: String!). Personal API keys
// go in Authorization as is; only OAuth tokens use "Bearer" (https://linear.app/developers/graphql).
// Schema reference: https://studio.apollographql.com/public/Linear-API/variant/current/schema/reference
//  - issueCreate / issueUpdate / commentCreate mutations; dueDate is a TimelessDate (YYYY-MM-DD)
//  - WorkflowState.type: triage | backlog | unstarted | started | completed | canceled
//  - Authorization header carries the personal API key as is (no "Bearer" prefix).
import type { Env } from "../types";
import { toMarkdown, type StatusKind } from "./describe";
import { expectOk, TrackerError, type NewIssue, type Tracker } from "./types";

const STATE_TYPE: Record<StatusKind, string> = {
  todo: "unstarted",
  doing: "started",
  done: "completed",
  cancel: "canceled",
};

export function linearFromEnv(env: Env): Tracker | null {
  if (!env.LINEAR_API_KEY || !env.LINEAR_TEAM_ID) return null;
  return new Linear(env.LINEAR_API_URL ?? "https://api.linear.app/graphql", env.LINEAR_API_KEY, env.LINEAR_TEAM_ID);
}

class Linear implements Tracker {
  constructor(private url: string, private apiKey: string, private teamId: string) {}

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { authorization: this.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const json = (await expectOk(res, "linear graphql")) as { data?: T; errors?: { message: string }[] };
    if (json.errors?.length) throw new TrackerError(`linear: ${json.errors.map((e) => e.message).join("; ")}`);
    return json.data as T;
  }

  private id(ref: string): string {
    if (!ref.startsWith("linear:")) throw new TrackerError(`not a linear ref: ${ref}`);
    return ref.slice(7).split("|")[0]!;
  }

  private async userId(email: string): Promise<string | null> {
    const d = await this.gql<{ users: { nodes: { id: string }[] } }>(
      `query($email: String!) { users(filter: { email: { eq: $email } }) { nodes { id } } }`,
      { email },
    );
    return d.users.nodes[0]?.id ?? null;
  }

  async createIssue(i: NewIssue) {
    const assigneeId = i.assigneeEmail ? await this.userId(i.assigneeEmail) : null;
    const input: Record<string, unknown> = {
      teamId: this.teamId,
      title: i.title,
      description: toMarkdown(i.description),
    };
    if (i.dueDate) input.dueDate = i.dueDate;
    if (assigneeId) input.assigneeId = assigneeId;
    const d = await this.gql<{
      issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } | null };
    }>(
      `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }`,
      { input },
    );
    const issue = d.issueCreate.issue;
    if (!d.issueCreate.success || !issue) throw new TrackerError("linear: issueCreate failed");
    return { ref: `linear:${issue.id}|${issue.identifier}`, url: issue.url, assigned: !!assigneeId };
  }

  private async update(ref: string, input: Record<string, unknown>) {
    const d = await this.gql<{ issueUpdate: { success: boolean } }>(
      `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
      { id: this.id(ref), input },
    );
    if (!d.issueUpdate.success) throw new TrackerError("linear: issueUpdate failed");
  }

  setDueDate(ref: string, date: string | null) {
    return this.update(ref, { dueDate: date });
  }

  async setAssignee(ref: string, email: string | null) {
    const assigneeId = email ? await this.userId(email) : null;
    await this.update(ref, { assigneeId });
    return !email || !!assigneeId;
  }

  async setStatus(ref: string, to: StatusKind) {
    const d = await this.gql<{ team: { states: { nodes: { id: string; type: string; position: number }[] } } }>(
      `query($id: String!) { team(id: $id) { states { nodes { id name type position } } } }`,
      { id: this.teamId },
    );
    const state = d.team.states.nodes
      .filter((s) => s.type === STATE_TYPE[to])
      .sort((a, b) => a.position - b.position)[0];
    if (!state) return false;
    await this.update(ref, { stateId: state.id });
    return true;
  }

  async comment(ref: string, text: string) {
    const d = await this.gql<{ commentCreate: { success: boolean } }>(
      `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
      { input: { issueId: this.id(ref), body: text } },
    );
    if (!d.commentCreate.success) throw new TrackerError("linear: commentCreate failed");
  }
}
