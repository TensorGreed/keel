/**
 * Start the Keel MCP server over stdio — the default `keel` command (and `keel serve`).
 *
 * Ingests git commits into the event log before serving; the store isn't wired into a
 * tool yet (Phase 1 simulation and Phase 2 PR events write into it) but ingestion runs
 * now so the timeline is populated. stdout carries the MCP protocol, so all logging goes
 * to stderr.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./mcp/tools.js";
import { loadGraph } from "./graph/cache.js";
import { SqliteEventStore } from "./events/sqlite-store.js";
import { ingestCommits } from "./events/ingest.js";
import { DECISIONS_FILE, importDecisions } from "./retrieval/decisions-file.js";

export async function serve(
  repoRoot = path.resolve(process.env["KEEL_REPO"] ?? process.cwd()),
): Promise<void> {
  if (!fs.existsSync(path.join(repoRoot, ".git"))) {
    // Not fatal — get_dependencies still works — but say so on stderr (stdout is protocol).
    console.error(`[keel] warning: ${repoRoot} is not a git repo; get_history will fail`);
  }

  const store = new SqliteEventStore(path.join(repoRoot, ".keel", "events.db"));

  // Decisions as code, before anything can read the index: a fresh clone has `.keel-decisions.jsonl`
  // from git but an empty `.keel/events.db`, and this is what turns the first into the second — no
  // mining, no model, no network. Cheap and idempotent (one stat() when nothing changed).
  try {
    const loaded = await importDecisions(store, repoRoot);
    for (const warning of loaded.warnings) console.error(`[keel] ${warning}`);
    if (loaded.imported > 0 || loaded.suppressed > 0) {
      console.error(
        `[keel] loaded ${loaded.imported} decision(s) from ${DECISIONS_FILE}` +
          `${loaded.suppressed > 0 ? ` (${loaded.suppressed} suppressed)` : ""} — team memory without mining`,
      );
    }
  } catch (err) {
    console.error(`[keel] could not load ${DECISIONS_FILE}: ${(err as Error).message}`);
  }

  try {
    await ingestCommits(store, repoRoot);
  } catch (err) {
    console.error(`[keel] commit ingestion failed: ${(err as Error).message}`);
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      store.close();
      process.exit(0);
    });
  }

  // Warm the graph cache up front (loads from disk or rebuilds, keyed by git HEAD) so the
  // first get_dependencies call is fast and the on-disk cache is primed.
  try {
    const started = Date.now();
    const { graph, source } = await loadGraph(repoRoot);
    console.error(
      `[keel] graph ready (${source}): ${graph.files.length} files in ${Date.now() - started}ms`,
    );
  } catch (err) {
    console.error(`[keel] graph warm-up failed: ${(err as Error).message}`);
  }

  // Keep it warm. A full rebuild costs seconds on a large repo and the cache forces one whenever a
  // file is added, removed or renamed — which is what an agent does constantly. Watching moves that
  // cost off the critical path: it happens moments after the edit instead of inside the next tool
  // call. Best-effort and opt-out; see watch/watcher.ts for why this is a watcher, not a daemon.
  if (process.env["KEEL_NO_WATCH"] !== "1") {
    const { startGraphWatcher } = await import("./watch/watcher.js");
    const watcher = startGraphWatcher(repoRoot, {
      onRefresh: (event) => console.error(`[keel] graph refreshed (${event.source}): ${event.files} files in ${event.durationMs}ms`),
      onError: (message) => console.error(`[keel] ${message}`),
    });
    if (watcher.active) console.error("[keel] watching for changes to keep the graph warm (KEEL_NO_WATCH=1 to disable)");
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => watcher.close());
  }

  const server = new McpServer({ name: "keel", version: "0.0.1" });
  registerTools(server, repoRoot, store);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[keel] serving ${repoRoot} over stdio`);
}
