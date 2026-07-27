-- Keel event log: one normalized, append-only timeline for everything that happens
-- to the engineering system. Simulation results are events too (the flywheel).
-- Persistence lands in Phase 0 roadmap item "Event log v1" (node:sqlite).

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,         -- commit | pr | review_comment | ci_run | deploy | incident | simulation
  external_id TEXT,                  -- e.g. commit sha, PR number, CI run id
  occurred_at TEXT NOT NULL,         -- ISO 8601
  actor       TEXT,                  -- author/committer/bot
  title       TEXT,                  -- subject line / PR title
  payload     TEXT NOT NULL,         -- kind-specific JSON
  UNIQUE (kind, external_id)
);

CREATE INDEX IF NOT EXISTS idx_events_kind_time ON events (kind, occurred_at);

-- Files touched by an event, for joining events to graph nodes.
CREATE TABLE IF NOT EXISTS event_files (
  event_id INTEGER NOT NULL REFERENCES events (id),
  path     TEXT NOT NULL,
  PRIMARY KEY (event_id, path)
);

CREATE INDEX IF NOT EXISTS idx_event_files_path ON event_files (path);
