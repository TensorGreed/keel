/**
 * `keel watch`: keep the graph warm, so no tool call pays to build it.
 *
 * ## Why this is a watcher and not a daemon
 *
 * The brief for this was "a daemon that keeps the substrate warm", conditional on measuring first.
 * Measured, on the 24k-file four-language repo the perf suite generates (`npm run test:perf`),
 * cold start in a fresh process:
 *
 *   | state                                          | cold start |
 *   |------------------------------------------------|------------|
 *   | no cache at all — first ever run               | 2.37 s     |
 *   | warm on-disk cache, clean tree (the usual case) | **0.20 s** |
 *   | one file's contents edited (incremental rescan) | 0.29 s     |
 *   | a file added / removed / renamed (full rebuild) | 2.48 s     |
 *
 * A HEAD-keyed cache that loads a 24k-file graph in 200ms leaves a daemon nothing to do: a resident
 * process would save under a fifth of a second on a repo far larger than most, at the cost of
 * lifecycle, staleness, IPC, and a thing to forget to restart. So there is no daemon.
 *
 * What the numbers DO show is a real gap, and it is the one this module closes. A full rebuild
 * costs 2.4s, and the cache rules force one whenever a file is added, removed or renamed — which is
 * what an agent does constantly. That 2.4s lands *inside* the next tool call, where someone is
 * waiting on it. Watching the repo moves it off the critical path — measured on the same repo, an
 * agent adding a file and then making a tool call:
 *
 *   without the watcher   next tool call: **2321 ms**
 *   with the watcher      next tool call: **46 ms**  (the 2353 ms rebuild ran in the background)
 *
 * Same work, nobody waiting for it.
 *
 * ## Contract
 *
 * Built on `fs.watch(dir, { recursive: true })` — no dependency, and recursive watching is
 * supported on Linux, macOS and Windows from the Node version keel already requires. It is a
 * best-effort optimisation and behaves like one: every failure degrades to "the graph gets built on
 * demand, as before". It never throws into its host, never holds the event loop open (timers and
 * the watcher are unref'd), never runs two rebuilds at once, and correctness is unchanged because
 * it calls exactly the same `loadGraph` any tool call would — the cache's
 * incremental-equals-full guarantee covers it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadGraph, type GraphSource } from "../graph/cache.js";
import { isGraphSourcePath } from "../graph/dependencies.js";
import { IGNORED_DIRS } from "../graph/shared.js";

/** Coalesce a burst of edits — a save, a formatter, a branch switch — into one rebuild. */
const DEFAULT_DEBOUNCE_MS = 400;

export interface WatchEvent {
  /** repo-relative posix path that triggered it, or null when the platform didn't say */
  path: string | null;
  source: GraphSource;
  files: number;
  durationMs: number;
}

export interface WatcherOptions {
  debounceMs?: number;
  /** called after each successful refresh — the hook the CLI prints from, and tests await */
  onRefresh?: (event: WatchEvent) => void;
  onError?: (message: string) => void;
}

export interface Watcher {
  /** stop watching and release the handle; idempotent */
  close(): void;
  /** true when the platform gave us a recursive watch */
  readonly active: boolean;
}

/**
 * Is this path worth a rebuild? The same exclusions the graph itself applies, so churn in
 * `node_modules`, `.git` or `.keel` — which is where the cache is WRITTEN, and would otherwise
 * make the watcher retrigger itself forever — never wakes anything up.
 */
export function isWatchRelevant(relPath: string): boolean {
  if (relPath === "") return false;
  const segments = relPath.split(/[\\/]/);
  if (segments.some((s) => IGNORED_DIRS.has(s) || s === ".keel" || s === ".git")) return false;
  // A config file changes resolution for the whole repo, so it matters even though it isn't source.
  const base = segments[segments.length - 1] ?? "";
  if (CONFIG_FILES.has(base)) return true;
  return isGraphSourcePath(segments.join("/"));
}

const CONFIG_FILES = new Set([
  "package.json", "tsconfig.json", "jsconfig.json", "pnpm-workspace.yaml", "pnpm-workspace.yml",
  "pyproject.toml", "setup.cfg", "go.mod", "go.work", "pom.xml", "build.gradle", "build.gradle.kts",
  "settings.gradle", "settings.gradle.kts",
]);

/**
 * Start watching `repoRoot`, refreshing the graph after each debounced burst of relevant changes.
 * Returns a handle whose `active` is false when the platform refused a recursive watch — in which
 * case nothing is broken, the graph is simply built on demand as it always was.
 */
export function startGraphWatcher(repoRoot: string, options: WatcherOptions = {}): Watcher {
  const root = path.resolve(repoRoot);
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const onRefresh = options.onRefresh ?? ((): void => {});
  const onError = options.onError ?? ((): void => {});

  let timer: NodeJS.Timeout | null = null;
  let pending: string | null = null;
  let running = false;
  /** an edit that landed while a rebuild was in flight — the rebuild must not miss it */
  let dirtyAgain = false;
  let closed = false;

  const refresh = async (): Promise<void> => {
    if (closed) return;
    if (running) {
      // Never two at once: a rebuild is CPU-bound, and overlapping them would turn a burst of saves
      // into a queue of full rebuilds. Remember that more work arrived and do one more pass after.
      dirtyAgain = true;
      return;
    }
    running = true;
    const triggeredBy = pending;
    pending = null;
    try {
      const started = Date.now();
      const { graph, source } = await loadGraph(root);
      onRefresh({ path: triggeredBy, source, files: graph.files.length, durationMs: Date.now() - started });
    } catch (err) {
      onError(`graph refresh failed: ${(err as Error).message}`);
    } finally {
      running = false;
      if (dirtyAgain && !closed) {
        dirtyAgain = false;
        void refresh();
      }
    }
  };

  const schedule = (relPath: string | null): void => {
    if (relPath !== null) pending = relPath;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void refresh();
    }, debounceMs);
    // Never keep a process alive just because a rebuild is pending.
    timer.unref?.();
  };

  let watcher: fs.FSWatcher | null = null;
  try {
    // Check the directory exists BEFORE asking to watch it. `fs.watch` doesn't reliably throw
    // synchronously for a missing path — on some Linux runners the failure arrives asynchronously on
    // the error event instead — which would leave `active` claiming a watch we don't have. `active`
    // has to mean what it says, so one stat buys that guarantee on every platform.
    if (!fs.statSync(root).isDirectory()) throw new Error(`${root} is not a directory`);

    watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (closed) return;
      const rel = typeof filename === "string" ? filename : "";
      // Some platforms report no filename at all; a nameless event still means *something* changed,
      // so schedule a refresh rather than dropping it — loadGraph is cheap when nothing moved.
      if (rel !== "" && !isWatchRelevant(rel)) return;
      schedule(rel === "" ? null : rel.split(path.sep).join("/"));
    });
    watcher.on("error", (err) => onError(`watch error: ${err.message}`));
    watcher.unref?.();
  } catch (err) {
    onError(`recursive file watching is unavailable here (${(err as Error).message}); the graph will be built on demand`);
    watcher = null;
  }

  return {
    active: watcher !== null,
    close(): void {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      watcher?.close();
      watcher = null;
    },
  };
}

/** Is recursive watching available on this platform/runtime? Used by `keel doctor`. */
export function recursiveWatchSupported(probeDir: string): boolean {
  try {
    const w = fs.watch(probeDir, { recursive: true }, () => {});
    w.close();
    return true;
  } catch {
    return false;
  }
}
