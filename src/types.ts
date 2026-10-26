// Shared contracts for every module. Change only with care: all modules depend on this.

import type { PlateKeeper } from "./keeper/PlateKeeper";

export interface Env {
  DB: D1Database;
  EXTRACT_QUEUE: Queue<ExtractJob>;
  KEEPER: DurableObjectNamespace<PlateKeeper>;
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
  OPENROUTER_API_KEY: string;
  EXTRACT_MODEL: string; // anthropic/claude-sonnet-5.5 (OpenRouter id)
  FAST_MODEL: string; // anthropic/claude-haiku-5.5
  DECIDE_MODEL: string; // typesafe/jev-1.14 (System One)
  /** Overrides for local integration runs against mock servers. Unset in production. */
  SLACK_API_URL?: string; // default https://slack.com/api
  LLM_BASE_URL?: string; // default https://openrouter.ai/api (/v1/messages and /v1/systemone)
  // Phase 3, all optional. Features switch off when their secrets are missing.
  SLACK_CLIENT_ID?: string; // user-token OAuth (DM context)
  SLACK_CLIENT_SECRET?: string;
  TOKEN_ENC_KEY?: string; // base64 32-byte AES key for user_tokens
  PUBLIC_URL?: string; // e.g. https://plates.example.workers.dev (OAuth redirect)
  TRACKER?: "jira" | "linear"; // tracker sync target; unset = off
  JIRA_BASE_URL?: string; // https://yourco.atlassian.net
  JIRA_EMAIL?: string;
  JIRA_API_TOKEN?: string;
  JIRA_PROJECT_KEY?: string;
  JIRA_ISSUE_TYPE?: string; // default "Task"
  LINEAR_API_KEY?: string;
  LINEAR_TEAM_ID?: string;
  LINEAR_API_URL?: string; // default https://api.linear.app/graphql
}

// ---------- Enums ----------

export type AskState =
  // on the owner's plate
  | "proposed"
  | "in_progress"
  | "accepted"
  | "snoozed"
  // on the requester's plate
  | "delivered"
  | "rejected"
  | "clarify"
  // ended (only the requester can get here)
  | "closed"
  | "withdrawn";

export const OWNER_PLATE_STATES: readonly AskState[] = ["proposed", "in_progress", "accepted", "snoozed"];
export const REQUESTER_PLATE_STATES: readonly AskState[] = ["delivered", "rejected", "clarify"];
export const TERMINAL_STATES: readonly AskState[] = ["closed", "withdrawn"];
export const ASK_STATES: readonly AskState[] = [...OWNER_PLATE_STATES, ...REQUESTER_PLATE_STATES, ...TERMINAL_STATES];

export type AskType = "deliverable" | "acknowledge" | "decision" | "info";
export type Size = "2-5min" | "lt1h" | "hours" | "days";
export type Urgency = "low" | "normal" | "high" | "urgent";
export type RequestStatus = "pending_confirmation" | "confirmed" | "discarded" | "dismissed";
export type Via = "button" | "home" | "thread_reply" | "reaction" | "dm" | "command" | "system";

export const SIZE_LABEL: Record<Size, string> = {
  "2-5min": "2–5 min",
  lt1h: "<1 hr",
  hours: "few hours",
  days: "few days",
};

// ---------- Rows ----------

export interface RequestRow {
  id: string;
  channel_id: string;
  thread_ts: string;
  message_ts: string | null;
  status: RequestStatus;
  tagged_by_id: string;
  tag_message_ts: string | null;
  requester_id: string | null;
  owner_id: string | null;
  attribution_confidence: number;
  attribution_reason: string | null;
  clarify_question: string | null;
  draft_json: string; // JSON DraftAsk[]
  confirmed_by: string | null;
  confirmed_via: Via | null;
  nudged_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface AskRow {
  id: string;
  request_id: string;
  requester_id: string;
  owner_id: string;
  holder_id: string;
  title: string;
  detail: string | null;
  type: AskType;
  state: AskState;
  snoozed_from: AskState | null;
  size: Size;
  size_source: "llm" | "owner";
  urgency: Urgency;
  urgency_source: "llm" | "owner";
  estimate_reason: string | null;
  inferred_due_at: number | null;
  deadline_at: number | null;
  deadline_change_count: number;
  snoozed_until: number | null;
  snooze_count: number;
  round_count: number;
  source_ts: string | null;
  source_permalink: string | null;
  next_step: string | null;
  done_link: string | null;
  last_note: string | null;
  created_at: number;
  accepted_at: number | null;
  closed_at: number | null;
  updated_at: number;
  reminder_stage: number;
  last_reminded_at: number | null;
  last_bumped_at: number | null;
  tracker_ref: string | null;
  tracker_url: string | null;
}

export interface AskEventRow {
  id: string;
  ask_id: string | null;
  request_id: string;
  actor_id: string;
  kind: string;
  from_state: AskState | null;
  to_state: AskState | null;
  note: string | null;
  via: Via;
  source_ts: string | null;
  at: number;
  prev_json: string | null; // AskRow before the transition (for undo)
}

export interface UserPrefsRow {
  user_id: string;
  tz: string;
  work_start_hour: number;
  work_end_hour: number;
  digest_time: string; // local HH:MM
  max_reminders_per_day: number;
  last_digest_at: number | null;
  updated_at: number;
  reminders_day: string | null; // local YYYY-MM-DD the counter applies to
  reminders_sent: number;
}

export type ProposalStatus = "pending" | "applied" | "dismissed" | "expired";
export interface ProposalRow {
  id: string;
  source: "reply" | "detector";
  request_id: string;
  ask_id: string | null;
  actor_id: string;
  action_json: string; // AskAction
  channel_id: string;
  thread_ts: string;
  source_ts: string;
  message_ts: string | null;
  status: ProposalStatus;
  created_at: number;
  updated_at: number;
}

/** One ask as extracted by the LLM, before confirmation. Stored in requests.draft_json. */
export interface DraftAsk {
  title: string;
  detail: string | null;
  type: AskType;
  size: Size;
  urgency: Urgency;
  estimate_reason: string;
  inferred_due_at: number | null;
  owner_already_committed: boolean;
  source_ts: string;
  source_permalink: string | null;
}

// ---------- Actions on an ask (input to the state machine) ----------

export type AskAction =
  // owner
  | { kind: "accept_now" }
  | { kind: "accept_later"; deadlineAt: number | null }
  | { kind: "done"; note?: string; link?: string }
  | { kind: "ack"; nextStep: string }
  | { kind: "reject"; reason?: string }
  | { kind: "send_back"; question: string }
  | { kind: "set_deadline"; deadlineAt: number | null }
  | { kind: "snooze"; until: number }
  | { kind: "set_estimate"; size?: Size; urgency?: Urgency }
  // owner or requester
  | { kind: "redirect"; toUserId: string; note?: string }
  // requester
  | { kind: "close"; note?: string }
  | { kind: "put_back"; note: string }
  | { kind: "withdraw"; note?: string }
  // system (PlateKeeper)
  | { kind: "wake" };

export type Actor = string | "system"; // Slack user id

// ---------- Side effects (returned by the domain service, executed by src/effects.ts) ----------

export type DmTemplate =
  | "request_proposed" // owner: new request with N asks (requestId)
  | "ask_proposed" // new holder: ask put back or redirected to them
  | "ask_delivered" // requester
  | "ask_rejected" // requester
  | "ask_clarify" // requester: owner needs more info
  | "deadline_changed" // requester
  | "ask_withdrawn" // owner
  | "confirm_nudge" // requester + owner: unconfirmed request reminder (requestId)
  | "confirm_request" // requester + owner (not the tagger): a request captured from a DM the bot can't post in (requestId; note = source link)
  | "reminder" // holder: one DM listing askIds that are due (snooze_count >= 3 → deadline/redirect/reject first)
  | "bump" // owner: requester bumped askId
  | "action_undone"; // user who was notified of an action that has now been undone

export type Effect =
  | { kind: "render_request"; requestId: string } // post or update the confirmation / live request message
  | {
      kind: "dm";
      userId: string;
      template: DmTemplate;
      requestId: string;
      askId?: string;
      note?: string;
      deadline?: { from: number | null; to: number | null }; // deadline_changed only
      askIds?: string[]; // reminder only
    }
  | { kind: "refresh_home"; userId: string }
  | { kind: "reschedule"; userId: string } // tell that user's PlateKeeper to recompute alarms
  | { kind: "thread_reply"; channelId: string; threadTs: string; text: string; replaceTs?: string } // plain text in a thread; edits the message at replaceTs instead of posting
  | { kind: "tracker_sync"; askId: string } // mirror a deliverable ask's state to Jira/Linear (no-op when off)
  // A DM whose button was used: its buttons for `blockId` become a line saying what happened.
  | { kind: "settle_dm"; channelId: string; ts: string; blockId: string; label: string; askId?: string; actorId?: string };

// ---------- Queue jobs ----------

export type ExtractJob =
  | {
      kind: "extract"; // fresh @plates tag
      channelId: string;
      threadTs: string | null; // null when tagged at top level of a channel
      messageTs: string; // the tagging message
      taggerId: string;
      text: string;
      /** How the capture started. Default "mention". */
      origin?: "mention" | "shortcut" | "command" | "dm";
      /** Author of the captured message (shortcut), when known. */
      sourceUserId?: string;
      /** Channel name from the shortcut payload ("directmessage", "mpdm-…"), used to classify DMs. */
      channelName?: string;
      /** ts of the "Reading the thread…" placeholder the bot posted; it becomes the card (or the failure note). */
      ackTs?: string;
    }
  | {
      kind: "correct"; // plain-language reply to a pending confirmation
      requestId: string;
      userId: string;
      text: string;
      messageTs: string;
    }
  | {
      kind: "intent"; // a reply in a thread with a confirmed request (Phase 2) — may become an action or proposal
      channelId: string;
      threadTs: string;
      messageTs: string;
      userId: string;
      text: string;
      files: { name: string | null; permalink: string | null }[];
      links: string[];
      /** The bot's own user id, so a redirect never targets it. */
      botUserId?: string;
    }
  | {
      kind: "clarify_reaction"; // unrecognised emoji on a pending confirmation
      requestId: string;
      userId: string;
      reaction: string;
    };

export class TransitionError extends Error {
  constructor(message: string, public readonly userMessage: string) {
    super(message);
  }
}
