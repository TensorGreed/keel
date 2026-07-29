/**
 * Incremental, git-keyed cache for the file graph.
 *
 * The graph is expensive to build (parse every source file), but it only changes when
 * source files change. This layer avoids rebuilding when it can, while guaranteeing the
 * result is always identical to a full buildFileGraph of the current working state —
 * persistence is a cache, never the source of truth (see docs/architecture.md). A missing,
 * stale, or corrupt cache simply triggers a rebuild, so the graph stays rebuildable from a
 * clean clone.
 *
 * Decision, given the last clean-committed graph on disk (keyed by its HEAD sha):
 *   - current HEAD == cached HEAD and no graph-affecting file is dirty  -> reuse as-is
 *   - only *contents* of existing files changed (no add/remove/config)  -> rescan those files
 *   - anything else (adds, removes, renames, config change, no cache)   -> full rebuild
 * The disk cache is written only when the working tree has no graph-affecting changes, so a
 * persisted graph always corresponds exactly to commit `head`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  buildFileGraph,
  deserializeFileGraph,
  isGraphSourcePath,
  serializeFileGraph,
  updateFileGraph,
  type FileGraph,
} from "./dependencies.js";
import { initGraphScanners } from "./scanners.js";
import { execFileTimed } from "../util/timeouts.js";

const CACHE_FILE = "graph.json";
const CONFIG_BASENAMES = new Set([
  "package.json", "jsconfig.json", "pnpm-workspace.yaml", "pnpm-workspace.yml",
  "pyproject.toml", "setup.cfg", // Python resolution roots (src/ layout package-dir)
]);

export type GraphSource = "memory" | "disk" | "incremental" | "rebuild";

export interface GraphLoad {
  graph: FileGraph;
  source: GraphSource;
  head: string | null;
}

interface DiskCache {
  head: string;
  graph: FileGraph;
}

// In-memory memo so repeated tool calls between edits don't re-run git or re-read the
// cache. Keyed by a cheap state token (HEAD + a hash of `git status`), so it self-
// invalidates the moment the working tree changes.
let memo: { repoRoot: string; token: string; load: GraphLoad } | null = null;

/** Reset cached state — for tests that reuse a path across distinct repos. */
export function resetGraphCache(): void {
  memo = null;
}

export async function loadGraph(repoRoot: string): Promise<GraphLoad> {
  const root = path.resolve(repoRoot);
  const head = await gitHead(root);
  const porcelain = await gitStatus(root);
  const dirty = porcelain === null ? null : relevantDirtyPaths(porcelain);

  // Token is stable while nothing graph-relevant changes, so repeated calls hit the memo.
  const token = `${head ?? "nogit"}:${dirty === null ? "nogit" : sha1([...dirty].sort().join("\n"))}`;
  if (memo && memo.repoRoot === root && memo.token === token) {
    return { ...memo.load, source: "memory" };
  }

  const load = await computeGraph(root, head, dirty);
  memo = { repoRoot: root, token, load };
  return load;
}

/**
 * The graph of commit HEAD, ignoring working-tree changes — the *baseline* a diff applies
 * to. Impact analysis needs this so a file deleted or modified in the working tree still
 * shows the dependents it had before the change. Uses the on-disk cache when it sits at
 * HEAD (the common "I have uncommitted edits" case); otherwise falls back to the current
 * graph, which equals HEAD when the tree is clean.
 */
export async function loadHeadGraph(repoRoot: string): Promise<{ graph: FileGraph; head: string | null }> {
  const root = path.resolve(repoRoot);
  const head = await gitHead(root);
  if (head !== null) {
    const cached = readDiskCache(root);
    if (cached && cached.head === head) return { graph: cached.graph, head };
  }
  const load = await loadGraph(root);
  return { graph: load.graph, head };
}

/** Read the contents of a path at commit HEAD (the pre-change baseline), or null. */
export async function gitShowHead(repoRoot: string, relPosixPath: string): Promise<string | null> {
  return git(path.resolve(repoRoot), ["show", `HEAD:${relPosixPath}`]);
}

async function computeGraph(root: string, head: string | null, dirty: Set<string> | null): Promise<GraphLoad> {
  // Any scan may hit a language needing async setup (the Python WASM runtime); do it once here,
  // before build/update, so the scanners stay synchronous.
  await initGraphScanners();

  // Without git we can't detect change precisely, so always rebuild (correct, just not cached).
  if (head === null || dirty === null) {
    return { graph: buildFileGraph(root), source: "rebuild", head };
  }

  const graphDirty = [...dirty].some((p) => isGraphSourcePath(p) || isConfigPath(p));

  const cached = readDiskCache(root);
  if (cached && cached.head === head && !graphDirty) {
    return { graph: cached.graph, source: "disk", head };
  }

  if (cached) {
    const committed = await gitDiffNames(root, cached.head);
    if (committed !== null) {
      const changed = new Set<string>([...committed, ...dirty]);
      const modified = classifyChanges(root, cached.graph, changed);
      if (modified !== null) {
        const graph = updateFileGraph(root, cached.graph, modified);
        if (!graphDirty) writeDiskCache(root, head, graph);
        return { graph, source: "incremental", head };
      }
    }
  }

  const graph = buildFileGraph(root);
  if (!graphDirty) writeDiskCache(root, head, graph);
  return { graph, source: "rebuild", head };
}

/**
 * Classify the changed paths against the cached (clean) graph. Returns the list of
 * modified source files if the change is safe for an incremental update, or null if a
 * full rebuild is required (a source file added or removed, or a resolver-config change —
 * any of which can silently reroute how *unchanged* files resolve their imports).
 */
function classifyChanges(root: string, cached: FileGraph, changed: Set<string>): string[] | null {
  const cachedFiles = new Set(cached.files);
  const modified: string[] = [];
  for (const p of changed) {
    if (isConfigPath(p)) return null; // resolver semantics may have changed repo-wide
    if (!isGraphSourcePath(p)) continue;
    // Spring DI edges are cross-file (an impl's change reroutes an injector elsewhere), so a Java
    // change can't be applied per-file — force a full rebuild that recomputes the DI overlay.
    if (p.endsWith(".java")) return null;
    const existsNow = isFile(path.resolve(root, p));
    const inCache = cachedFiles.has(p);
    if (existsNow && inCache) modified.push(p);
    else if (existsNow !== inCache) return null; // added or removed -> rebuild
    // else: a non-cache path that no longer exists (added then removed) -> ignore
  }
  return modified;
}

function isConfigPath(relPosixPath: string): boolean {
  const segments = relPosixPath.split("/");
  if (segments.some((seg) => seg === "node_modules")) return false;
  const base = segments[segments.length - 1] ?? "";
  return CONFIG_BASENAMES.has(base) || /^tsconfig(\..+)?\.json$/.test(base);
}

// --- disk cache -------------------------------------------------------------

function cachePath(root: string): string {
  return path.join(root, ".keel", CACHE_FILE);
}

function readDiskCache(root: string): DiskCache | null {
  let raw: string;
  try {
    raw = fs.readFileSync(cachePath(root), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { head, graph } = parsed as { head?: unknown; graph?: unknown };
  if (typeof head !== "string") return null;
  const deserialized = deserializeFileGraph(graph);
  return deserialized ? { head, graph: deserialized } : null;
}

function writeDiskCache(root: string, head: string, graph: FileGraph): void {
  const finalPath = cachePath(root);
  // Write to a unique temp file in the same dir, then atomically rename over the target. A reader
  // (or a concurrent writer — server + hook can both refresh) only ever sees the old file or the
  // whole new one, never a half-written cache; and a crash mid-write leaves only the temp file
  // (ignored, garbage-collected on the next successful write's rename). rename is atomic within a
  // filesystem, which .keel/ always is.
  const tmpPath = `${finalPath}.${process.pid}.${nextTmpSeq()}.tmp`;
  try {
    fs.mkdirSync(path.join(root, ".keel"), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify({ head, graph: serializeFileGraph(graph) }));
    fs.renameSync(tmpPath, finalPath);
  } catch {
    // A cache we can't persist is not fatal — the in-memory graph is already correct. Clean up a
    // temp file we may have left behind so it doesn't accumulate.
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* best effort */
    }
  }
}

// Monotonic within a process so two writes from the same pid can't collide on a temp name.
let tmpSeq = 0;
function nextTmpSeq(): number {
  return tmpSeq++;
}

// --- git helpers ------------------------------------------------------------

async function git(root: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileTimed("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024, label: `git ${args[0] ?? ""}` });
    return stdout;
  } catch {
    return null;
  }
}

async function gitHead(root: string): Promise<string | null> {
  const out = await git(root, ["rev-parse", "HEAD"]);
  return out === null ? null : out.trim() || null;
}

async function gitStatus(root: string): Promise<string | null> {
  return git(root, ["status", "--porcelain", "--no-renames", "-z", "-uall"]);
}

async function gitDiffNames(root: string, fromSha: string): Promise<string[] | null> {
  const out = await git(root, ["diff", "--name-only", "--no-renames", "-z", `${fromSha}..HEAD`]);
  return out === null ? null : splitNul(out);
}

/**
 * Paths from `git status --porcelain -z`: each record is "XY <path>\0". Keel's own scratch
 * dir (.keel/: the cache we just wrote, the events DB, WAL files) is excluded — it never
 * affects the graph, and letting it perturb the state would defeat the memo.
 */
function relevantDirtyPaths(porcelain: string): Set<string> {
  const paths = new Set<string>();
  for (const record of porcelain.split("\0")) {
    if (record.length <= 3) continue;
    const p = record.slice(3);
    if (p === ".keel" || p.startsWith(".keel/")) continue;
    paths.add(p);
  }
  return paths;
}

function splitNul(out: string): string[] {
  return out.split("\0").filter((s) => s.length > 0);
}

// --- misc -------------------------------------------------------------------

function isFile(absPath: string): boolean {
  try {
    return fs.statSync(absPath).isFile();
  } catch {
    return false;
  }
}

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}
