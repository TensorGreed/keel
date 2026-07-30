-- Keel event log: one normalized, append-only timeline for everything that happens
-- to the engineering system. Simulation results are events too (the flywheel).
-- Persistence lands in Phase 0 roadmap item "Event log v1" (node:sqlite).

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,         -- commit | pr | review_comment | decision | ci_run | deploy
                                     -- | incident | simulation | upgrade_repair
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

-- Key/value store for ingestion bookkeeping: schema version, last ingested git sha,
-- and (later) connector cursors. Keeps the events tables free of housekeeping rows.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Embeddings for semantic retrieval (decision records today). Computed offline by a local
-- model — the vector is a float32 array stored as a BLOB; dim lets us validate on read.
-- One row per event; recomputed by replacing the row.
CREATE TABLE IF NOT EXISTS embeddings (
  event_id INTEGER PRIMARY KEY REFERENCES events (id),
  dim      INTEGER NOT NULL,
  vector   BLOB NOT NULL
);

-- Human overrides: a rejected decision stays in the log (auditable) but is excluded from
-- `why` results. Keyed by external_id so a suppression survives re-mining — the miner never
-- resurrects a rejected record.
CREATE TABLE IF NOT EXISTS suppressed_decisions (
  external_id TEXT PRIMARY KEY
);

-- Which PRs the miner has processed, and at what updated_at — so re-running mines only new
-- or changed PRs and never re-charges the model for a PR that yielded no decision. Keyed by
-- the PR's external_id; a bumped updated_at (new comment/review) re-opens it for mining.
CREATE TABLE IF NOT EXISTS mined_prs (
  external_id TEXT PRIMARY KEY,
  updated_at  TEXT NOT NULL
);
