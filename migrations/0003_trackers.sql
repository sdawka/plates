-- Phase 3: last state mirrored to the external tracker, per ask (idempotent redelivery of tracker_sync).
CREATE TABLE tracker_sync (
  ask_id      TEXT PRIMARY KEY,
  state       TEXT,            -- ask state last mirrored (null right after the issue was created)
  deadline_at INTEGER,         -- due date last pushed
  owner_id    TEXT,            -- Slack owner last pushed as assignee
  creating_at INTEGER,         -- lease: a sync is creating the issue (epoch ms); stale after ~2 minutes
  updated_at  INTEGER NOT NULL
);
