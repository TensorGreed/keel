/**
 * `keel ingest` — backfill GitHub PRs + review threads into the event log. Lazy-loaded from
 * index.ts so it doesn't pull in SQLite/fetch unless invoked.
 */
import * as path from "node:path";
import { SqliteEventStore } from "../events/sqlite-store.js";
import { FetchGitHubClient } from "./client.js";
import { ingestGitHub } from "./ingest.js";
import { resolveRepoRef } from "./remote.js";

const INGEST_HELP = `keel ingest — backfill GitHub PRs + review threads into the event log

Usage: keel ingest [--repo owner/repo] [--max-pages N]

  --repo owner/repo   the repo to ingest (default: the origin remote)
  --max-pages N       PR-list pages per run (default 10 / KEEL_INGEST_MAX_PAGES)

Auth: set GITHUB_TOKEN for higher rate limits; without it, public repos work
at 60 requests/hour. Safe to re-run — it resumes from where it left off.`;

/** Emit to stderr — stdout stays clean for the summary line. */
function warn(message: string): void {
  process.stderr.write(`[keel] ${message}\n`);
}

export async function runIngest(argv: string[]): Promise<number> {
  let repoOverride: string | undefined;
  let maxPages: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(INGEST_HELP);
      return 0;
    }
    if (arg === "--repo" || arg === "--max-pages") {
      const value = argv[++i];
      if (value === undefined) {
        warn(`ingest: ${arg} needs a value`);
        return 1;
      }
      if (arg === "--repo") {
        repoOverride = value;
      } else {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) {
          warn(`ingest: --max-pages must be a positive integer, got "${value}"`);
          return 1;
        }
        maxPages = Math.floor(n);
      }
    } else {
      warn(`ingest: unexpected argument ${arg}`);
      return 1;
    }
  }

  const repoRoot = path.resolve(process.env["KEEL_REPO"] ?? process.cwd());
  const ref = await resolveRepoRef(repoRoot, repoOverride);
  if ("error" in ref) {
    warn(`ingest failed: ${ref.error}`);
    return 1;
  }

  const token = process.env["GITHUB_TOKEN"];
  if (!token) {
    warn("no GITHUB_TOKEN: ingesting unauthenticated (public repos only, 60 requests/hour). Set GITHUB_TOKEN for higher limits.");
  }

  const store = new SqliteEventStore(path.join(repoRoot, ".keel", "events.db"));
  try {
    const result = await ingestGitHub(store, new FetchGitHubClient(token), ref, maxPages !== undefined ? { maxPages } : {});

    console.log(
      `[keel] ${result.mode}: ingested ${result.ingested} new event(s) from ${result.prs} PR(s) ` +
        `and ${result.reviewComments} review comment(s) in ${result.repo}`,
    );
    if (result.error) {
      warn(`ingest error: ${result.error} — partial progress saved, safe to re-run`);
      return 1;
    }
    if (result.stopped === "page-cap") {
      warn(`hit the page cap; raise KEEL_INGEST_MAX_PAGES (or --max-pages) to ingest more history`);
    }
    if (result.stopped === "rate-limit") {
      const when = result.rateReset ? ` (resets around ${new Date(result.rateReset * 1000).toISOString()})` : "";
      warn(`GitHub rate limit reached${when}; resume by re-running${token ? "" : " — set GITHUB_TOKEN to raise the limit"}`);
    }
    return 0;
  } finally {
    store.close();
  }
}
