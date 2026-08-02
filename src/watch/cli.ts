/**
 * `keel watch` — the pre-warm as a foreground command.
 *
 * Two ways to get it. The MCP server starts the same watcher itself, so an agent session is warm
 * without anyone asking; this command is for the case where you want the repo warm *without* a
 * session — before a big `preflight`, or on a machine that just pulled — and for watching what the
 * graph is doing while you work.
 *
 * It runs in the foreground and prints one line per refresh. There is no daemon and nothing to
 * clean up: Ctrl-C ends it. See watcher.ts for why a resident process isn't warranted.
 */
import * as path from "node:path";
import { loadGraph } from "../graph/cache.js";
import { startGraphWatcher } from "./watcher.js";

const WATCH_HELP = `keel watch — keep the graph warm as files change

Usage: keel watch [--debounce MS]

  --debounce MS   coalesce a burst of edits into one rebuild (default 400)

Builds the graph once, then rebuilds it in the background after each debounced burst of relevant
changes, so the next tool call finds it ready instead of paying to build it. Ignores everything the
graph ignores (node_modules, .git, .keel, build output).

The MCP server runs this same watcher itself, so an agent session is already warm — this command is
for keeping a repo warm outside one. Foreground; Ctrl-C to stop. Reads KEEL_REPO or the cwd.`;

export async function runWatch(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(WATCH_HELP);
    return 0;
  }

  const repoRoot = path.resolve(process.env["KEEL_REPO"] ?? process.cwd());
  const debounceIndex = argv.indexOf("--debounce");
  const debounceRaw = debounceIndex >= 0 ? argv[debounceIndex + 1] : undefined;
  const debounce = Number(debounceRaw);
  const debounceMs = Number.isFinite(debounce) && debounce > 0 ? Math.floor(debounce) : undefined;

  // Build once up front, so "watching" starts from a warm graph rather than an empty one.
  try {
    const started = Date.now();
    const { graph, source } = await loadGraph(repoRoot);
    console.log(`[keel] graph ready (${source}): ${graph.files.length} files in ${Date.now() - started}ms`);
  } catch (err) {
    console.error(`[keel] initial graph build failed: ${(err as Error).message}`);
    return 1;
  }

  const watcher = startGraphWatcher(repoRoot, {
    ...(debounceMs !== undefined ? { debounceMs } : {}),
    onRefresh: (event) => {
      console.log(
        `[keel] refreshed (${event.source}): ${event.files} files in ${event.durationMs}ms` +
          `${event.path ? ` — triggered by ${event.path}` : ""}`,
      );
    },
    onError: (message) => console.error(`[keel] ${message}`),
  });

  if (!watcher.active) {
    console.error("[keel] nothing to watch with — exiting rather than pretending to watch");
    return 1;
  }

  console.log(`[keel] watching ${repoRoot} — Ctrl-C to stop`);
  return await new Promise<number>((resolve) => {
    // The watcher is unref'd (it must never hold a host process open), so this command keeps
    // ITSELF alive with an explicit interval, and stops cleanly on a signal.
    const keepAlive = setInterval(() => {}, 1 << 30);
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        watcher.close();
        clearInterval(keepAlive);
        console.log("\n[keel] stopped watching");
        resolve(0);
      });
    }
  });
}
