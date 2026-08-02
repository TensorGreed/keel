/**
 * `keel ingest` — populate the event log. Two sources: a LOCAL one that always runs (ADRs under
 * docs/adr and docs/decisions — repo-only value, no network), and GitHub PRs + review threads when
 * a remote resolves. Lazy-loaded from index.ts so it doesn't pull in SQLite/fetch unless invoked.
 */
import * as path from "node:path";
import { ingestAdrs } from "../adr/ingest.js";
import { writeDecisionExport } from "../retrieval/decisions-export.js";
import { loadGraph } from "../graph/cache.js";
import { embedDecisions, OllamaEmbeddingModel } from "../retrieval/embed.js";
import { SqliteEventStore } from "../events/sqlite-store.js";
import { FetchGitHubClient } from "./client.js";
import { ingestGitHub } from "./ingest.js";
import { resolveRepoRef } from "./remote.js";

const INGEST_HELP = `keel ingest — populate the event log from ADRs (local) and GitHub PRs

Usage: keel ingest [--repo owner/repo] [--max-pages N]

  --repo owner/repo   the GitHub repo to ingest (default: the origin remote)
  --max-pages N       PR-list pages per run (default 10 / KEEL_INGEST_MAX_PAGES)

ADRs under docs/adr/ and docs/decisions/ are ingested locally on every run — no
network or remote needed. GitHub PR ingestion also runs when a remote resolves;
set GITHUB_TOKEN for higher rate limits (public repos work at 60 requests/hour).
Backfill prints per-page progress to stderr; each request times out after 30s
(KEEL_HTTP_TIMEOUT, in seconds). Safe to re-run — both sources resume from where
they left off (a timeout or rate limit stops cleanly, never a hang).`;

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
  const store = new SqliteEventStore(path.join(repoRoot, ".keel", "events.db"));
  try {
    // --- local source: ADRs (always, no network) ---
    const { graph } = await loadGraph(repoRoot);
    const adr = await ingestAdrs(store, repoRoot, new Set(graph.files));
    console.log(
      `[keel] ADRs: ${adr.ingested} ingested, ${adr.unchanged} unchanged (${adr.scanned} scanned, ${adr.linked} linked to code)`,
    );
    if (adr.ingested > 0) {
      // Best-effort local embedding so ADRs are semantically searchable too (offline; never fatal).
      const embed = await embedDecisions(store, new OllamaEmbeddingModel(process.env["KEEL_EMBED_MODEL"], process.env["KEEL_OLLAMA_URL"]));
      if (embed.error) warn(`ADRs not embedded (${embed.error}); keyword search still works, 'keel mine' can embed later`);
    }

    // --- GitHub PRs (only when a remote resolves) ---
    const ref = await resolveRepoRef(repoRoot, repoOverride);
    if ("error" in ref) {
      warn(`skipping GitHub ingest (${ref.error}); ADRs ingested locally`);
      await writeDecisionExport(store, repoRoot);
      return 0;
    }
    const token = process.env["GITHUB_TOKEN"];
    // The auth mode + target are announced by ingestGitHub itself (via onProgress), so a
    // misconfiguration is visible on the first line, and each page of the backfill reports progress
    // to stderr — a long run is never mistaken for a hang.
    const result = await ingestGitHub(store, new FetchGitHubClient(token), ref, {
      ...(maxPages !== undefined ? { maxPages } : {}),
      onProgress: warn,
    });
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
    if (result.stopped === "timeout") {
      warn(`a GitHub request timed out (raise KEEL_HTTP_TIMEOUT if your network is slow); progress saved, resume by re-running`);
    }
    await writeDecisionExport(store, repoRoot);
    return 0;
  } finally {
    store.close();
  }
}
