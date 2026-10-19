import type { Paragraph, StatusKind } from "./describe";

export interface NewIssue {
  title: string;
  description: Paragraph[];
  dueDate: string | null; // YYYY-MM-DD
  assigneeEmail: string | null;
}

/** Provider-neutral client. `ref` is the stored tracker_ref ("jira:KEY-1", "linear:<id>|ENG-34"). */
export interface Tracker {
  /** Returns the ref to store and the browsable URL. `assigned` is false when the email matched no user. */
  createIssue(issue: NewIssue): Promise<{ ref: string; url: string; assigned: boolean }>;
  setDueDate(ref: string, date: string | null): Promise<void>;
  /** Returns false when the email matched no tracker user (the issue is then unassigned). */
  setAssignee(ref: string, email: string | null): Promise<boolean>;
  /** Returns false when the tracker has no matching state/transition. */
  setStatus(ref: string, to: StatusKind): Promise<boolean>;
  comment(ref: string, text: string): Promise<void>;
}

export class TrackerError extends Error {}

export async function expectOk(res: Response, what: string): Promise<unknown> {
  const text = await res.text();
  if (!res.ok) throw new TrackerError(`${what}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
