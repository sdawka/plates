-- Phase 2: undo, reminders, bump, "did you mean" proposals. Phase 3: tracker links, user tokens.

-- Snapshot of the ask before the transition, so the actor can undo it.
ALTER TABLE ask_events ADD COLUMN prev_json TEXT;

-- Reminder ladder bookkeeping (owned by PlateKeeper).
ALTER TABLE asks ADD COLUMN reminder_stage INTEGER NOT NULL DEFAULT 0;   -- reminders sent in the current ladder
ALTER TABLE asks ADD COLUMN last_reminded_at INTEGER;
ALTER TABLE asks ADD COLUMN last_bumped_at INTEGER;                      -- requester Bump, once per day
-- External tracker (Jira / Linear) for deliverable asks.
ALTER TABLE asks ADD COLUMN tracker_ref TEXT;                            -- e.g. "jira:PROJ-12", "linear:ENG-34"
ALTER TABLE asks ADD COLUMN tracker_url TEXT;

-- Daily reminder cap bookkeeping, keyed by the user's local day.
ALTER TABLE user_prefs ADD COLUMN reminders_day TEXT;                    -- YYYY-MM-DD local
ALTER TABLE user_prefs ADD COLUMN reminders_sent INTEGER NOT NULL DEFAULT 0;

-- An action the bot inferred but wants confirmed ("Did you mean…?"), from a thread reply
-- (source = 'reply') or from delivery detection (source = 'detector').
CREATE TABLE proposals (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,              -- reply | detector
  request_id  TEXT NOT NULL,
  ask_id      TEXT,                       -- null when the ask is ambiguous (user picks)
  actor_id    TEXT NOT NULL,              -- who would perform the action
  action_json TEXT NOT NULL,              -- AskAction
  channel_id  TEXT NOT NULL,
  thread_ts   TEXT NOT NULL,
  source_ts   TEXT NOT NULL,              -- the message the proposal came from
  message_ts  TEXT,                       -- the bot's "Did you mean" message
  status      TEXT NOT NULL,              -- pending | applied | dismissed | expired
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_proposals_source ON proposals(channel_id, source_ts);
CREATE INDEX idx_proposals_status ON proposals(status, created_at);

-- Opt-in Slack user tokens (Phase 3) so extraction can read DM context the user is part of.
CREATE TABLE user_tokens (
  user_id     TEXT PRIMARY KEY,
  token_enc   TEXT NOT NULL,              -- AES-GCM, base64(iv || ciphertext), key = TOKEN_ENC_KEY
  scopes      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
