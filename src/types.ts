// Shared contracts for every module. Change only with care: all modules depend on this.

import type { PlateKeeper } from "./keeper/PlateKeeper";

export interface Env {
  DB: D1Database;
  EXTRACT_QUEUE: Queue<ExtractJob>;
  KEEPER: DurableObjectNamespace<PlateKeeper>;
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  EXTRACT_MODEL: string; // claude-sonnet-5-5
  FAST_MODEL: string; // claude-haiku-5-5
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

export type AskType = "deliverable" | "acknowledge" | "decision" | "info";
export type Size = "2-5min" | "lt1h" | "hours" | "days";
export type Urgency = "low" | "normal" | "high" | "urgent";
export type RequestStatus = "pending_confirmation" | "confirmed" | "discarded";
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
  | "confirm_nudge"; // requester + owner: unconfirmed request reminder (requestId)

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
    }
  | { kind: "refresh_home"; userId: string }
  | { kind: "reschedule"; userId: string } // tell that user's PlateKeeper to recompute alarms
  | { kind: "thread_reply"; channelId: string; threadTs: string; text: string }; // plain text in a thread

// ---------- Queue jobs ----------

export type ExtractJob =
  | {
      kind: "extract"; // fresh @plates tag
      channelId: string;
      threadTs: string | null; // null when tagged at top level of a channel
      messageTs: string; // the tagging message
      taggerId: string;
      text: string;
    }
  | {
      kind: "correct"; // plain-language reply to a pending confirmation
      requestId: string;
      userId: string;
      text: string;
      messageTs: string;
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
