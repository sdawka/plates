-- One row per Plates invocation (HTTP request, queue batch, Durable Object alarm), from the Tail Worker.
CREATE TABLE invocations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,            -- event timestamp, epoch ms
  kind        TEXT NOT NULL,               -- fetch | queue | alarm | scheduled | rpc | other
  summary     TEXT NOT NULL,               -- e.g. "slack event app_mention · 200"
  outcome     TEXT NOT NULL,               -- ok | exception | exceededCpu | canceled | …
  level       TEXT NOT NULL,               -- error | warn | info
  cpu_ms      INTEGER,
  wall_ms     INTEGER,
  lines_json  TEXT NOT NULL,               -- [{ t, level, text }]
  search      TEXT NOT NULL                -- lowercased summary and lines, for filtering
);
CREATE INDEX idx_inv_at ON invocations(at DESC);
CREATE INDEX idx_inv_level ON invocations(level, at DESC);
