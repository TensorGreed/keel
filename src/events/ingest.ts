/**
 * Ingest git commits into the event store on startup. Plain ETL: read commits with git,
 * write them as `commit` events. Idempotent (UNIQUE(kind, external_id) + INSERT OR
 * IGNORE) and incremental (a cursor in the meta table), so restarts are cheap and never
 * duplicate. No LLM calls in this layer (see CLAUDE.md).
 */
import { execFileTimed } from "../util/timeouts.js";
import { listCommits, type CommitRecord } from "../git/commits.js";
import type { KeelEvent } from "./store.js";
import type { SqliteEventStore } from "./sqlite-store.js";

const LAST_SHA_KEY = "git.last_sha";
const DEFAULT_BACKFILL_LIMIT = 5000;

export interface IngestResult {
  mode: "backfill" | "incremental" | "skipped";
  /** commits examined this run */
  scanned: number;
  /** commits newly inserted (excludes idempotent duplicates) */
  ingested: number;
  /** HEAD sha recorded as the cursor, if any commits exist */
  lastSha?: string;
}

export interface IngestOptions {
  /** cap for the initial backfill; defaults to KEEL_BACKFILL_LIMIT env or 5000 */
  backfillLimit?: number;
}

/** Emit a stderr line — never stdout, which carries the MCP protocol. */
function log(message: string): void {
  process.stderr.write(`[keel] ${message}\n`);
}

async function isGitRepo(repoRoot: string): Promise<boolean> {
  try {
    await execFileTimed("git", ["rev-parse", "--git-dir"], { cwd: repoRoot, label: "git rev-parse --git-dir" });
    return true;
  } catch {
    return false;
  }
}

function toEvent(commit: CommitRecord): KeelEvent {
  const event: KeelEvent = {
    kind: "commit",
    externalId: commit.sha,
    occurredAt: commit.date,
    actor: commit.author,
    title: commit.subject,
    payload: {
      sha: commit.sha,
      author: commit.author,
      email: commit.email,
      body: commit.body,
    },
  };
  if (commit.files.length > 0) event.files = commit.files;
  return event;
}

export async function ingestCommits(
  store: SqliteEventStore,
  repoRoot: string,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const backfillLimit =
    options.backfillLimit ??
    (Number(process.env["KEEL_BACKFILL_LIMIT"]) || DEFAULT_BACKFILL_LIMIT);

  if (!(await isGitRepo(repoRoot))) {
    log(`${repoRoot} is not a git repo; skipping commit ingestion`);
    return { mode: "skipped", scanned: 0, ingested: 0 };
  }

  const started = performance.now();
  const lastSha = store.getMeta(LAST_SHA_KEY);

  let commits: CommitRecord[];
  let mode: "backfill" | "incremental";
  if (lastSha) {
    try {
      commits = await listCommits(repoRoot, { range: `${lastSha}..HEAD` });
      mode = "incremental";
    } catch {
      // The cursor no longer resolves (history rewritten, branch switched, shallow
      // fetch): fall back to a full backfill rather than silently ingesting nothing.
      log(`cursor ${lastSha.slice(0, 7)} no longer resolves; re-running full backfill`);
      commits = await listCommits(repoRoot, { limit: backfillLimit });
      mode = "backfill";
    }
  } else {
    commits = await listCommits(repoRoot, { limit: backfillLimit });
    mode = "backfill";
  }

  if (commits.length === 0) {
    log(`no new commits to ingest (${mode})`);
    return { mode, scanned: 0, ingested: 0, ...(lastSha ? { lastSha } : {}) };
  }

  // git returns newest-first; the newest is the new cursor. Insert oldest-first so row
  // ids climb with commit age, giving a stable newest-first tiebreak when author dates
  // collide within a second.
  const newestSha = commits[0]!.sha;
  const ingested = store.appendMany(commits.slice().reverse().map(toEvent));
  store.setMeta(LAST_SHA_KEY, newestSha);

  const ms = Math.round(performance.now() - started);
  const since = mode === "incremental" && lastSha ? ` since ${lastSha.slice(0, 7)}` : "";
  log(`ingested ${ingested} new commit(s)${since} (${commits.length} scanned) in ${ms}ms`);

  return { mode, scanned: commits.length, ingested, lastSha: newestSha };
}
