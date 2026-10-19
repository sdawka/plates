-- Plates schema. All timestamps are epoch milliseconds (INTEGER).

-- One @plates tag → one or more requests (one per requester→owner pair found).
CREATE TABLE requests (
  id                     TEXT PRIMARY KEY,
  channel_id             TEXT NOT NULL,
  thread_ts              TEXT NOT NULL,           -- thread root the request lives in
  message_ts             TEXT,                    -- confirmation message, later the live request message
  status                 TEXT NOT NULL,           -- pending_confirmation | confirmed | discarded
  tagged_by_id           TEXT NOT NULL,
  tag_message_ts         TEXT,                    -- the @plates message; dedups queue redelivery
  requester_id           TEXT,                    -- null while attribution is unresolved
  owner_id               TEXT,
  attribution_confidence REAL NOT NULL DEFAULT 0,
  attribution_reason     TEXT,
  clarify_question       TEXT,                    -- shown in the confirmation when attribution is unclear
  draft_json             TEXT NOT NULL,           -- DraftAsk[] until confirmed
  confirmed_by           TEXT,
  confirmed_via          TEXT,                    -- reaction | reply | button
  nudged_at              INTEGER,                 -- unconfirmed reminder sent
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);
CREATE INDEX idx_requests_thread  ON requests(channel_id, thread_ts);
CREATE INDEX idx_requests_message ON requests(channel_id, message_ts);
CREATE INDEX idx_requests_pending ON requests(status, created_at);
CREATE INDEX idx_requests_tag     ON requests(channel_id, tag_message_ts);

CREATE TABLE asks (
  id                    TEXT PRIMARY KEY,
  request_id            TEXT NOT NULL REFERENCES requests(id),
  requester_id          TEXT NOT NULL,
  owner_id              TEXT NOT NULL,
  holder_id             TEXT NOT NULL,            -- whose plate it is on right now
  title                 TEXT NOT NULL,
  detail                TEXT,
  type                  TEXT NOT NULL,            -- deliverable | acknowledge | decision | info
  state                 TEXT NOT NULL,            -- see AskState in src/types.ts
  snoozed_from          TEXT,                     -- state to return to on wake
  size                  TEXT NOT NULL,            -- 2-5min | lt1h | hours | days
  size_source           TEXT NOT NULL DEFAULT 'llm',
  urgency               TEXT NOT NULL,            -- low | normal | high | urgent
  urgency_source        TEXT NOT NULL DEFAULT 'llm',
  estimate_reason       TEXT,
  inferred_due_at       INTEGER,
  deadline_at           INTEGER,
  deadline_change_count INTEGER NOT NULL DEFAULT 0,
  snoozed_until         INTEGER,
  snooze_count          INTEGER NOT NULL DEFAULT 0,
  round_count           INTEGER NOT NULL DEFAULT 0,
  source_ts             TEXT,
  source_permalink      TEXT,
  next_step             TEXT,
  done_link             TEXT,
  last_note             TEXT,                     -- latest reason / question / put-back note
  created_at            INTEGER NOT NULL,
  accepted_at           INTEGER,
  closed_at             INTEGER,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX idx_asks_holder    ON asks(holder_id, state);
CREATE INDEX idx_asks_requester ON asks(requester_id, state);
CREATE INDEX idx_asks_owner     ON asks(owner_id, state);
CREATE INDEX idx_asks_request   ON asks(request_id);
CREATE INDEX idx_asks_snoozed   ON asks(state, snoozed_until);

CREATE TABLE ask_events (
  id          TEXT PRIMARY KEY,
  ask_id      TEXT,                               -- null for request-level events
  request_id  TEXT NOT NULL,
  actor_id    TEXT NOT NULL,                      -- Slack user id or 'system'
  kind        TEXT NOT NULL,
  from_state  TEXT,
  to_state    TEXT,
  note        TEXT,
  via         TEXT NOT NULL,                      -- button | home | thread_reply | reaction | dm | command | system
  source_ts   TEXT,
  at          INTEGER NOT NULL
);
CREATE INDEX idx_events_ask     ON ask_events(ask_id, at);
CREATE INDEX idx_events_request ON ask_events(request_id, at);

CREATE TABLE user_prefs (
  user_id               TEXT PRIMARY KEY,
  tz                    TEXT NOT NULL DEFAULT 'UTC',
  work_start_hour       INTEGER NOT NULL DEFAULT 9,
  work_end_hour         INTEGER NOT NULL DEFAULT 17,
  digest_time           TEXT NOT NULL DEFAULT '09:00',   -- local HH:MM
  max_reminders_per_day INTEGER NOT NULL DEFAULT 5,
  last_digest_at        INTEGER,
  updated_at            INTEGER NOT NULL
);
