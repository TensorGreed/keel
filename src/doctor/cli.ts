/**
 * `keel doctor` CLI — gather the real environment facts (defensively: a probe never throws) and
 * hand them to the pure checker in doctor.ts. Table by default, `--json` for machines, exit 1 if
 * anything is red. All network/subprocess probes go through src/util/timeouts.ts, so every one is
 * bounded (the GitHub and Ollama probes get a short 2s leash — doctor should be quick).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { FetchGitHubClient } from "../github/client.js";
import { GitHubError } from "../github/client.js";
import { isBatchFile, resolveOnPath } from "../util/platform.js";
import { execFileTimed } from "../util/timeouts.js";
import { doctorExitCode, renderDoctorTable, runDoctorChecks, type DoctorEnv } from "./doctor.js";

const DOCTOR_HELP = `keel doctor — check that keel can work in this environment

Usage: keel doctor [--json] [--no-graph]

  --json       emit the full report as JSON instead of a table
  --no-graph   skip the timed graph build (the one probe whose cost scales with the repo)

Probes Node/git versions, the repo, the event db, the graph cache, a timed cold graph build, Ollama
+ required models, GITHUB_TOKEN validity, available test runners, and the .mcp.json / hook
registration. Each failing line names a fix. Exit code: 1 if anything is red (a hard failure), else
0. Reads KEEL_REPO or cwd.`;

const PROBE_TIMEOUT_MS = 2_000; // doctor stays snappy; a slow probe is itself a finding
const RUNNER_PROBE_TIMEOUT_MS = 5_000;

async function gitLine(root: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileTimed("git", args, { cwd: root, timeoutMs: PROBE_TIMEOUT_MS, label: `git ${args[0]}` });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function probeDb(dbPath: string): Promise<DoctorEnv["db"]> {
  if (!fs.existsSync(dbPath)) return { state: "absent" };
  try {
    const { SqliteEventStore } = await import("../events/sqlite-store.js");
    const store = new SqliteEventStore(dbPath);
    try {
      return { state: "ok", counts: { commits: store.count("commit"), prs: store.count("pr"), decisions: store.count("decision") } };
    } finally {
      store.close();
    }
  } catch (err) {
    return { state: "error", error: (err as Error).message };
  }
}

function probeCache(root: string, head: string | null): DoctorEnv["cache"] {
  try {
    const raw = fs.readFileSync(path.join(root, ".keel", "graph.json"), "utf8");
    const parsed = JSON.parse(raw) as { head?: unknown };
    if (typeof parsed.head !== "string") return { state: "absent" };
    return parsed.head === head ? { state: "fresh", head: parsed.head } : { state: "stale", head: parsed.head, current: head };
  } catch {
    return { state: "absent" };
  }
}

async function probeOllama(): Promise<DoctorEnv["ollama"]> {
  const base = (process.env["KEEL_OLLAMA_URL"] ?? "http://localhost:11434").replace(/\/$/, "");
  const required = [process.env["KEEL_EMBED_MODEL"] ?? "nomic-embed-text", process.env["KEEL_MINER_MODEL"] ?? "llama3.2"];
  try {
    const { fetchTimed } = await import("../util/timeouts.js");
    const res = await fetchTimed(`${base}/api/tags`, {}, PROBE_TIMEOUT_MS, "Ollama /api/tags");
    if (!res.ok) return { reachable: false, models: [], required };
    const data = (await res.json()) as { models?: { name?: string }[] };
    const models = (data.models ?? []).map((m) => m.name ?? "").filter(Boolean);
    return { reachable: true, models, required };
  } catch {
    return { reachable: false, models: [], required };
  }
}

async function probeGithub(): Promise<DoctorEnv["github"]> {
  const token = process.env["GITHUB_TOKEN"];
  if (!token) return { state: "absent" };
  try {
    const client = new FetchGitHubClient(token, PROBE_TIMEOUT_MS);
    const { data } = await client.get<{ rate?: { limit: number; remaining: number } }>("/rate_limit");
    return { state: "valid", remaining: data.rate?.remaining ?? 0, limit: data.rate?.limit ?? 0 };
  } catch (err) {
    if (err instanceof GitHubError && err.status === 401) return { state: "invalid", error: err.message };
    return { state: "error", error: (err as Error).message };
  }
}

/**
 * Is this runner usable? Resolve the name on PATH first, then run its version flag on the concrete
 * file. Resolving matters on Windows twice over: a bare `mvn` there is really `mvn.cmd`, which an
 * exec call can't run at all — so without resolving, an installed Maven would be reported missing.
 * For a batch shim, presence on PATH *is* the finding; we don't shell out just to print a version.
 */
async function probeRunner(cmd: string, args: string[]): Promise<boolean> {
  const resolved = resolveOnPath(cmd);
  if (!resolved) return false;
  if (isBatchFile(resolved)) return true;
  try {
    await execFileTimed(resolved, args, { timeoutMs: RUNNER_PROBE_TIMEOUT_MS, label: `${cmd} ${args[0] ?? ""}` });
    return true;
  } catch {
    return false;
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function probeMcp(root: string): boolean {
  const cfg = readJson(path.join(root, ".mcp.json")) as { mcpServers?: Record<string, unknown> } | null;
  return Boolean(cfg && typeof cfg.mcpServers === "object" && cfg.mcpServers !== null && "keel" in cfg.mcpServers);
}

function probeHook(root: string): boolean {
  const cfg = readJson(path.join(root, ".claude", "settings.json")) as
    | { hooks?: { UserPromptSubmit?: { hooks?: { command?: unknown }[] }[] } }
    | null;
  const groups = cfg?.hooks?.UserPromptSubmit ?? [];
  return groups.some((g) => (g.hooks ?? []).some((h) => typeof h.command === "string" && /prompt-context/.test(h.command)));
}

/** Gather every fact from the real environment. Defensive: any probe failure becomes a finding. */
/**
 * Time a COLD graph build over this repo. This is the one probe whose cost scales with the target —
 * seconds on a large monorepo — and that is the point: the first graph-backed tool call pays exactly
 * this, and until now a user on a monster repo had no way to tell a slow build from a hang. Timed
 * cold on purpose (buildFileGraph directly, bypassing the on-disk cache), since timing a cache hit
 * would measure nothing. Defensive like every other probe: a failure becomes a finding.
 */
async function probeGraphBuild(root: string, isRepo: boolean, skip: boolean): Promise<DoctorEnv["graphBuild"]> {
  if (skip) return { state: "skipped", reason: "--no-graph" };
  if (!isRepo) return { state: "skipped", reason: "not a git repo" };
  try {
    const { buildFileGraph } = await import("../graph/dependencies.js");
    const { initGraphScanners } = await import("../graph/scanners.js");
    await initGraphScanners(); // the tree-sitter grammars; excluded from the timing below
    const started = Date.now();
    const graph = buildFileGraph(root);
    const ms = Date.now() - started;
    let edges = 0;
    for (const targets of graph.imports.values()) edges += targets.size;
    return { state: "measured", files: graph.files.length, edges, ms };
  } catch (err) {
    return { state: "error", error: (err as Error).message };
  }
}

export async function gatherDoctorEnv(root: string, options: { skipGraph?: boolean } = {}): Promise<DoctorEnv> {
  const gitVersion = await gitLine(root, ["--version"]);
  const isRepo = (await gitLine(root, ["rev-parse", "--is-inside-work-tree"])) === "true";
  const head = isRepo ? await gitLine(root, ["rev-parse", "HEAD"]) : null;

  const [db, ollama, github, node, pytest, go, mvn, gradle] = await Promise.all([
    probeDb(path.join(root, ".keel", "events.db")),
    probeOllama(),
    probeGithub(),
    probeRunner("node", ["--version"]),
    probeRunner("pytest", ["--version"]),
    probeRunner("go", ["version"]),
    probeRunner("mvn", ["-v"]),
    probeRunner("gradle", ["-v"]),
  ]);

  return {
    root,
    nodeVersion: process.version,
    gitVersion,
    isRepo,
    db,
    cache: probeCache(root, head),
    ollama,
    github,
    runners: [
      { name: "node", available: node },
      { name: "pytest", available: pytest },
      { name: "go", available: go },
      { name: "mvn", available: mvn },
      { name: "gradle", available: gradle },
    ],
    graphBuild: await probeGraphBuild(root, isRepo, options.skipGraph ?? false),
    mcpRegistered: probeMcp(root),
    hookInstalled: probeHook(root),
  };
}

export async function runDoctor(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(DOCTOR_HELP);
    return 0;
  }
  const asJson = argv.includes("--json");
  const root = path.resolve(process.env["KEEL_REPO"] ?? process.cwd());

  const env = await gatherDoctorEnv(root, { skipGraph: argv.includes("--no-graph") });
  const results = runDoctorChecks(env);
  const exit = doctorExitCode(results);

  if (asJson) {
    console.log(JSON.stringify({ root, results, exit }, null, 2));
  } else {
    const color = Boolean(process.stdout.isTTY) && process.env["NO_COLOR"] === undefined;
    console.log(renderDoctorTable(root, results, color));
  }
  return exit;
}
