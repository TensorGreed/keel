/**
 * `keel doctor` — a preflight health check for a keel install. It probes the environment (Node/git
 * versions, the repo, the event db, the graph cache, Ollama, GITHUB_TOKEN, test runners, and the
 * .mcp.json / hook registration) and prints a table with one named fix per failing line.
 *
 * This module is the PURE core: `runDoctorChecks` takes an already-gathered `DoctorEnv` (a plain
 * facts object) and maps it to typed results, so every probe is faked in tests by varying a field.
 * The real IO that gathers those facts lives in cli.ts (defensive — a probe never throws).
 */

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  /** a concrete, named remedy — shown under any non-ok line */
  fix?: string;
}

/** The gathered facts each probe produces. cli.ts fills these in from the real environment. */
export interface DoctorEnv {
  root: string;
  nodeVersion: string; // e.g. "v24.14.0"
  gitVersion: string | null;
  isRepo: boolean;
  db:
    | { state: "absent" }
    | { state: "ok"; counts: { commits: number; prs: number; decisions: number } }
    | { state: "error"; error: string };
  cache: { state: "absent" } | { state: "fresh"; head: string } | { state: "stale"; head: string; current: string | null };
  /** a timed COLD graph build over this repo — the number that explains a slow first tool call */
  graphBuild:
    | { state: "skipped"; reason: string }
    | { state: "measured"; files: number; edges: number; ms: number }
    | { state: "error"; error: string };
  ollama: { reachable: boolean; models: string[]; required: string[] };
  github:
    | { state: "absent" }
    | { state: "valid"; remaining: number; limit: number }
    | { state: "invalid"; error: string }
    | { state: "error"; error: string };
  runners: { name: string; available: boolean }[];
  mcpRegistered: boolean;
  hookInstalled: boolean;
  /** the pre-warm watcher: whether this platform supports it, and whether it's switched on */
  watch: { supported: boolean; enabled: boolean };
}

const MIN_NODE = { major: 22, minor: 13 };

function sha7(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "unknown";
}

/** Parse "v24.14.0" → {major,minor}; NaN-safe. */
function parseNode(v: string): { major: number; minor: number } {
  const m = /v?(\d+)\.(\d+)/.exec(v);
  return { major: m ? Number(m[1]) : 0, minor: m ? Number(m[2]) : 0 };
}

function nodeCheck(env: DoctorEnv): CheckResult {
  const { major, minor } = parseNode(env.nodeVersion);
  const ok = major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor);
  return ok
    ? { name: "Node", status: "ok", detail: `${env.nodeVersion} (>= 22.13)` }
    : {
        name: "Node",
        status: "fail",
        detail: `${env.nodeVersion} is older than 22.13`,
        fix: "install Node >= 22.13 (node:sqlite is unflagged there; keel needs it)",
      };
}

function gitCheck(env: DoctorEnv): CheckResult {
  return env.gitVersion
    ? { name: "git", status: "ok", detail: env.gitVersion }
    : { name: "git", status: "fail", detail: "git not found on PATH", fix: "install git — keel reads history and diffs through it" };
}

function repoCheck(env: DoctorEnv): CheckResult {
  return env.isRepo
    ? { name: "Repo", status: "ok", detail: `git repo detected at ${env.root}` }
    : {
        name: "Repo",
        status: "warn",
        detail: `${env.root} is not a git repo — graph, history, and verdict are limited`,
        fix: "run keel from inside a git repo, or set KEEL_REPO to one",
      };
}

function dbCheck(env: DoctorEnv): CheckResult {
  switch (env.db.state) {
    case "ok":
      return {
        name: "Event log",
        status: "ok",
        detail: `open — commits ${env.db.counts.commits}, PRs ${env.db.counts.prs}, decisions ${env.db.counts.decisions}`,
      };
    case "absent":
      return {
        name: "Event log",
        status: "warn",
        detail: "no .keel/events.db yet",
        fix: "run `keel serve` (ingests commits on startup) or `keel ingest`",
      };
    case "error":
      return {
        name: "Event log",
        status: "fail",
        detail: `cannot open .keel/events.db: ${env.db.error}`,
        fix: "the db may be corrupt — move .keel/events.db aside and re-run to rebuild it",
      };
  }
}

function cacheCheck(env: DoctorEnv): CheckResult {
  switch (env.cache.state) {
    case "fresh":
      return { name: "Graph cache", status: "ok", detail: `at HEAD ${sha7(env.cache.head)}` };
    case "stale":
      return {
        name: "Graph cache",
        status: "warn",
        detail: `cached for ${sha7(env.cache.head)}, HEAD is ${sha7(env.cache.current)} — rebuilds on next tool call`,
        fix: "none needed — the next graph tool call refreshes it",
      };
    case "absent":
      return {
        name: "Graph cache",
        status: "warn",
        detail: "not built yet",
        fix: "none needed — built on the first graph tool call (e.g. get_dependencies)",
      };
  }
}

/**
 * Budget for a cold graph build, per file. keel measures ~0.09 ms/file on a 24k-file
 * four-language repo (docs/architecture.md, test/ci/perf.test.ts); 1 ms/file is an order of
 * magnitude of headroom, so crossing it on a real repo means something about *that* repo is
 * expensive — which is exactly what someone on a monster monorepo needs told.
 */
const SLOW_BUILD_MS_PER_FILE = 1.0;
/** And an absolute ceiling, because a big-but-efficient repo can still make the first call feel hung. */
const SLOW_BUILD_TOTAL_MS = 30_000;
/**
 * Below this, the per-file rate says nothing: one-time costs (loading the tsconfig, scanning the
 * workspace) dominate, so a 200-file repo reads as "slow per file" while taking a fifth of a second
 * in total. Small repos are judged by the absolute ceiling alone — which they can't reach.
 */
const RATE_MEANINGFUL_ABOVE_FILES = 500;

function graphBuildCheck(env: DoctorEnv): CheckResult {
  const build = env.graphBuild;
  if (build.state === "skipped") {
    return { name: "Graph build", status: "warn", detail: `not measured — ${build.reason}` };
  }
  if (build.state === "error") {
    return {
      name: "Graph build",
      status: "fail",
      detail: `the graph could not be built: ${build.error}`,
      fix: "run a graph tool (e.g. `keel report --arch`) to see the full error; this blocks every graph-backed tool",
    };
  }
  const { files, edges, ms } = build;
  const perFile = files > 0 ? ms / files : 0;
  const detail = `${files} files, ${edges} edges in ${(ms / 1000).toFixed(1)}s (${perFile.toFixed(2)} ms/file)`;
  const rateIsSlow = files >= RATE_MEANINGFUL_ABOVE_FILES && perFile > SLOW_BUILD_MS_PER_FILE;
  if (rateIsSlow || ms > SLOW_BUILD_TOTAL_MS) {
    return {
      name: "Graph build",
      status: "warn",
      detail: rateIsSlow
        ? `${detail} — slower than the ${SLOW_BUILD_MS_PER_FILE} ms/file budget`
        : `${detail} — over ${SLOW_BUILD_TOTAL_MS / 1000}s, so the first graph tool call will feel slow`,
      fix:
        "the cost is paid once per HEAD (.keel/graph.json caches it), so persist .keel/ between CI runs; " +
        "if it's every run, look for a large generated/vendored tree the walker isn't skipping",
    };
  }
  return { name: "Graph build", status: "ok", detail };
}

/**
 * The graph pre-warm. Not a daemon and not required — a HEAD-keyed cache already loads a 24k-file
 * graph in ~200ms (see watch/watcher.ts). What it buys is the rebuild a file ADD forces, moved off
 * the critical path. So an unavailable or disabled watcher is a warning at most, never a failure.
 */
function watchCheck(env: DoctorEnv): CheckResult {
  if (!env.watch.supported) {
    return {
      name: "Graph pre-warm",
      status: "warn",
      detail: "recursive file watching is unavailable here — the graph is built on demand instead (slower first call after adding a file)",
      fix: "none needed; nothing is broken, and `keel watch` would report the same",
    };
  }
  if (!env.watch.enabled) {
    return {
      name: "Graph pre-warm",
      status: "warn",
      detail: "supported, but disabled by KEEL_NO_WATCH=1",
      fix: "unset KEEL_NO_WATCH to let the server keep the graph warm between tool calls",
    };
  }
  return { name: "Graph pre-warm", status: "ok", detail: "supported and enabled — the server rebuilds the graph in the background as files change" };
}

function ollamaCheck(env: DoctorEnv): CheckResult {
  if (!env.ollama.reachable) {
    return {
      name: "Ollama",
      status: "warn",
      detail: "not reachable — semantic retrieval falls back to keyword (optional)",
      fix: "start Ollama (`ollama serve`) if you want local embeddings; set KEEL_OLLAMA_URL if remote",
    };
  }
  const missing = env.ollama.required.filter((m) => !env.ollama.models.some((have) => have === m || have.startsWith(`${m}:`)));
  if (missing.length > 0) {
    return {
      name: "Ollama",
      status: "warn",
      detail: `reachable, but required model(s) not pulled: ${missing.join(", ")}`,
      fix: `run ${missing.map((m) => `\`ollama pull ${m}\``).join(" and ")}`,
    };
  }
  return { name: "Ollama", status: "ok", detail: `reachable — models present: ${env.ollama.required.join(", ")}` };
}

function githubCheck(env: DoctorEnv): CheckResult {
  switch (env.github.state) {
    case "valid":
      return { name: "GITHUB_TOKEN", status: "ok", detail: `valid — ${env.github.remaining}/${env.github.limit} rate limit remaining` };
    case "absent":
      return {
        name: "GITHUB_TOKEN",
        status: "warn",
        detail: "not set — PR ingestion uses unauthenticated GitHub (low rate limits) (optional)",
        fix: "export GITHUB_TOKEN=<personal access token> to raise the limit and reach private repos",
      };
    case "invalid":
      return {
        name: "GITHUB_TOKEN",
        status: "fail",
        detail: `invalid or expired: ${env.github.error}`,
        fix: "replace GITHUB_TOKEN (needs `repo`/read scope), or unset it to use unauthenticated access",
      };
    case "error":
      return {
        name: "GITHUB_TOKEN",
        status: "warn",
        detail: `could not verify (network): ${env.github.error}`,
        fix: "re-run when GitHub is reachable, or ignore if you don't use PR ingestion",
      };
  }
}

function runnersCheck(env: DoctorEnv): CheckResult {
  const matrix = env.runners.map((r) => `${r.name} ${r.available ? "✓" : "✗"}`).join(", ");
  const anyAvailable = env.runners.some((r) => r.available);
  if (!anyAvailable) {
    return {
      name: "Test runners",
      status: "warn",
      detail: `none available (${matrix}) — preflight/verdict can't execute tests`,
      fix: "install a runner for your stack (node, pytest, go, mvn, or gradle)",
    };
  }
  const missing = env.runners.filter((r) => !r.available).map((r) => r.name);
  return {
    name: "Test runners",
    status: "ok",
    detail: matrix,
    ...(missing.length > 0 ? { fix: `optional: install ${missing.join(", ")} to run those languages' tests` } : {}),
  };
}

function mcpCheck(env: DoctorEnv): CheckResult {
  return env.mcpRegistered
    ? { name: ".mcp.json", status: "ok", detail: "keel registered as an MCP server" }
    : { name: ".mcp.json", status: "warn", detail: "keel not registered", fix: "run `keel init` to register the MCP server" };
}

function hookCheck(env: DoctorEnv): CheckResult {
  return env.hookInstalled
    ? { name: "Prompt hook", status: "ok", detail: "prompt-context UserPromptSubmit hook installed" }
    : { name: "Prompt hook", status: "warn", detail: "prompt-context hook not installed (optional)", fix: "run `keel init` to install it" };
}

/** Run every check against the gathered facts, in display order. Pure. */
export function runDoctorChecks(env: DoctorEnv): CheckResult[] {
  return [
    nodeCheck(env),
    gitCheck(env),
    repoCheck(env),
    dbCheck(env),
    cacheCheck(env),
    graphBuildCheck(env),
    watchCheck(env),
    ollamaCheck(env),
    githubCheck(env),
    runnersCheck(env),
    mcpCheck(env),
    hookCheck(env),
  ];
}

/** 1 if anything is red (a hard failure), else 0. Warnings do not fail the check. */
export function doctorExitCode(results: CheckResult[]): number {
  return results.some((r) => r.status === "fail") ? 1 : 0;
}

const MARK: Record<CheckStatus, string> = { ok: "✓", warn: "⚠", fail: "✗" };
const COLOR: Record<CheckStatus, string> = { ok: "\x1b[32m", warn: "\x1b[33m", fail: "\x1b[31m" };
const RESET = "\x1b[0m";

/** Human table. `color` adds ANSI (the CLI passes false when not a TTY / NO_COLOR). */
export function renderDoctorTable(root: string, results: CheckResult[], color: boolean): string {
  const width = Math.max(...results.map((r) => r.name.length));
  const paint = (s: string, st: CheckStatus): string => (color ? `${COLOR[st]}${s}${RESET}` : s);
  const lines: string[] = [`keel doctor — ${root}`, ""];
  for (const r of results) {
    lines.push(`  ${paint(MARK[r.status], r.status)}  ${r.name.padEnd(width)}  ${r.detail}`);
    if (r.status !== "ok" && r.fix) lines.push(`     ${" ".repeat(width)}  ↳ fix: ${r.fix}`);
  }
  const fails = results.filter((r) => r.status === "fail").length;
  const warns = results.filter((r) => r.status === "warn").length;
  const oks = results.filter((r) => r.status === "ok").length;
  lines.push("", `${fails} failed, ${warns} warning${warns === 1 ? "" : "s"}, ${oks} ok`);
  return lines.join("\n");
}
