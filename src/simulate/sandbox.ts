/**
 * Sandbox runner: apply a change in an isolated git worktree and run the selected tests.
 * This is where the flight simulator stops predicting and starts proving — the output is
 * executed results, not static guesses (see CLAUDE.md "proof over prediction").
 *
 * The worktree is a detached checkout of HEAD sharing the main repo's .git; node_modules is
 * symlinked so tests resolve their deps without a reinstall. The diff (provided, or the
 * working tree's own changes) is applied there, the selected tests run under a wall-time
 * cap, and the worktree is torn down. The main working tree is never touched.
 *
 * Runner is auto-detected from the selected tests: Python tests run under pytest (JUnit-reported,
 * reusing the ci/junit parser); otherwise, from package.json, vitest or jest (JSON-reported, so
 * failures are structured), else Node's built-in `node --test`. No LLM, no network.
 */
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { parseJUnit } from "../ci/junit.js";
import { pythonModuleRoots } from "../graph/python-scanner.js";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TESTS = 50;
const MAX_CAPTURE_BYTES = 512 * 1024; // cap captured output so a chatty run can't OOM us
const OUTPUT_TAIL = 8_000;

export type Runner = "vitest" | "jest" | "node" | "pytest";

export type RunStatus =
  | "passed"
  | "failed"
  | "no-tests"
  | "apply-failed"
  | "timed-out"
  | "runner-unsupported"
  | "runner-unavailable"
  | "error";

export interface TestFailure {
  name: string;
  file?: string;
  /** the failure's first line — a one-line summary */
  message: string;
  /** the full error/stack the runner reported, capped; omitted when it adds nothing to message */
  trace?: string;
  /** "collection-error" for a test file pytest couldn't import/collect (vs a real assertion) */
  kind?: "collection-error";
}

export interface SandboxResult {
  status: RunStatus;
  runner: Runner | null;
  ranTests: string[];
  passed?: number;
  failed?: number;
  failures?: TestFailure[];
  exitCode?: number | null;
  durationMs: number;
  timedOut?: boolean;
  /** set when maxTests capped the selection */
  capped?: { requested: number; ran: number };
  /** tail of combined stdout/stderr — the trace, and the fallback when JSON isn't available */
  output?: string;
  error?: string;
}

export interface SandboxOptions {
  /** unified diff to apply; omit to reproduce the main repo's uncommitted changes */
  diff?: string;
  /** selected test files to run (repo-relative posix paths) */
  testFiles: string[];
  timeoutMs?: number;
  maxTests?: number;
}

interface ProcResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  spawnError?: string;
}

/** Run a child process, capturing bounded output, killed after timeoutMs. Never rejects. */
function runProcess(
  command: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; env?: Record<string, string> },
): Promise<ProcResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, CI: "true", FORCE_COLOR: "0", ...opts.env },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const capture = (chunk: Buffer, sink: "out" | "err"): void => {
      if (sink === "out" && stdout.length < MAX_CAPTURE_BYTES) stdout += chunk.toString();
      else if (sink === "err" && stderr.length < MAX_CAPTURE_BYTES) stderr += chunk.toString();
    };
    child.stdout.on("data", (c: Buffer) => capture(c, "out"));
    child.stderr.on("data", (c: Buffer) => capture(c, "err"));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: null, timedOut, spawnError: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string } | null> {
  try {
    return await execFileAsync("git", args, { cwd, maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return null;
  }
}

function detectRunner(worktree: string): "vitest" | "jest" | "node" {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(worktree, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps["vitest"]) return "vitest";
    if (deps["jest"]) return "jest";
  } catch {
    // no/broken package.json -> fall back to Node's built-in runner
  }
  return "node";
}

function isPythonTest(file: string): boolean {
  return file.endsWith(".py") || file.endsWith(".pyi");
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

interface Interpreter {
  cmd: string;
  /** a short, stable label for messages (repo-relative when under the repo) */
  label: string;
}

/**
 * The Python interpreter to run pytest with: the repo's virtualenv when present (the analog of
 * symlinking node_modules — it carries the project's installed deps), else `python3` on PATH.
 */
function findPythonInterpreter(repoRoot: string): Interpreter {
  const venv = process.env["VIRTUAL_ENV"];
  const candidates = [
    venv ? path.join(venv, "bin", "python") : null,
    path.join(repoRoot, ".venv", "bin", "python"),
    path.join(repoRoot, "venv", "bin", "python"),
    venv ? path.join(venv, "Scripts", "python.exe") : null,
    path.join(repoRoot, ".venv", "Scripts", "python.exe"),
  ].filter((p): p is string => p !== null);
  for (const cmd of candidates) {
    if (isFile(cmd)) return { cmd, label: cmd.startsWith(repoRoot + path.sep) ? path.relative(repoRoot, cmd) : cmd };
  }
  return { cmd: "python3", label: "python3" };
}

/** The concrete exception line from a traceback body (e.g. "ModuleNotFoundError: No module ...").
 *  pytest colorizes the JUnit longrepr even under --color=no, so strip ANSI before matching. */
function exceptionLine(details: string | undefined): string | undefined {
  if (!details) return undefined;
  const lines = stripAnsi(details).split("\n").map((l) => l.trim().replace(/^E\s+/, "")).filter(Boolean);
  const exc = [...lines].reverse().find((l) => /^\w*(Error|Exception|Warning):/.test(l));
  return exc ?? lines.find((l) => /ImportError while importing/.test(l)) ?? lines[0];
}

/**
 * Normalize a parsed pytest JUnit report into sandbox counts + failures. Two things pytest's
 * JUnit makes us reconstruct:
 *   - it emits no per-case `file`, so we recover it from the classname (real tests) or the case
 *     name (collection errors) — both a dotted module path whose last segment is the file's
 *     basename — matched against the files we actually ran, which is what gives failures a
 *     graph path back to the change; and
 *   - a file it couldn't import surfaces as an `<error message="collection failure">` with an
 *     empty classname. We record those as their own failure records (kind "collection-error",
 *     the ImportError line as message) so one broken sub-project can't mask the real results.
 */
function pytestResults(
  xml: string,
  worktree: string,
  ranTests: string[],
): { passed: number; failed: number; failures: TestFailure[]; total: number } {
  const byBasename = new Map<string, string>();
  for (const t of ranTests) byBasename.set(path.posix.basename(t).replace(/\.pyi?$/, ""), t);
  const fileOf = (t: { file?: string; classname?: string; name?: string }): string | undefined => {
    if (t.file) return toRepoRel(worktree, t.file);
    for (const src of [t.classname, t.name]) {
      const base = (src ?? "").split(".").pop();
      if (base && byBasename.has(base)) return byBasename.get(base);
    }
    return undefined;
  };

  const report = parseJUnit(xml);
  let passed = 0;
  let failed = 0;
  const failures: TestFailure[] = [];
  for (const t of report.tests) {
    if (t.status === "passed") {
      passed++;
      continue;
    }
    if (t.status === "skipped") continue;

    failed++;
    const file = fileOf(t);
    const isCollectionError = t.status === "error" && (!t.classname || t.message === "collection failure");
    if (isCollectionError) {
      const message = exceptionLine(t.details) ?? t.message ?? "collection error";
      failures.push({ name: t.name || "(collection error)", ...(file ? { file } : {}), message, kind: "collection-error" });
    } else {
      const message = (t.message ?? "(no message)").split("\n", 1)[0]!.trim() || "(no message)";
      failures.push({ name: t.name || "(unnamed test)", ...(file ? { file } : {}), message });
    }
  }
  return { passed, failed, failures, total: report.tests.length };
}

/** Parse Jest-schema JSON (vitest emits the same) into normalized failures. */
export function parseJestJson(
  text: string,
  worktree: string,
): { passed: number; failed: number; failures: TestFailure[] } | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const report = data as {
    numPassedTests?: number;
    numFailedTests?: number;
    testResults?: {
      name?: string;
      assertionResults?: { fullName?: string; title?: string; status?: string; failureMessages?: string[] }[];
    }[];
  };
  if (!Array.isArray(report.testResults)) return null;

  const failures: TestFailure[] = [];
  for (const suite of report.testResults) {
    const file = suite.name ? toRepoRel(worktree, suite.name) : undefined;
    for (const assertion of suite.assertionResults ?? []) {
      if (assertion.status === "failed") {
        // Keep the full stack the reporter gives us (capped), with message as its first line.
        const trace = capLines((assertion.failureMessages ?? []).join("\n\n").trim(), MAX_TRACE_LINES);
        const message = (trace.split("\n", 1)[0] || "(no message)").trim();
        failures.push({
          name: assertion.fullName || assertion.title || "(unnamed test)",
          ...(file ? { file } : {}),
          message,
          ...(trace && trace !== message ? { trace } : {}),
        });
      }
    }
  }
  return {
    passed: report.numPassedTests ?? 0,
    failed: report.numFailedTests ?? failures.length,
    failures,
  };
}

const MAX_TRACE_LINES = 50;

/** Cap a trace to at most `max` lines, noting how many were dropped. */
function capLines(text: string, max: number): string {
  const lines = text.split("\n");
  if (lines.length <= max) return text;
  return [...lines.slice(0, max), `… (${lines.length - max} more lines)`].join("\n");
}

function toRepoRel(root: string, absolute: string): string {
  const rel = path.isAbsolute(absolute) ? path.relative(root, absolute) : absolute;
  return rel.split(path.sep).join(path.posix.sep);
}

function tail(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > OUTPUT_TAIL ? "…" + trimmed.slice(-OUTPUT_TAIL) : trimmed;
}

/**
 * Drop ANSI SGR color codes so captured text stays plain. Matches both a real ESC (in the
 * output tail) and pytest's JUnit escaping of the illegal ESC byte as the literal `#x1B`
 * (colorized longreprs still leak into the XML even under --color=no when CI is set).
 */
function stripAnsi(text: string): string {
  return text.replace(/(?:\x1b|#x1[bB];?)\[[0-9;]*m/g, "");
}

/** Reproduce the main repo's uncommitted state in the worktree: apply tracked changes and
 *  copy untracked source files. Returns an error message on failure. */
async function applyChange(
  repoRoot: string,
  worktree: string,
  diff: string | undefined,
): Promise<string | null> {
  let patch = diff;
  if (patch === undefined) {
    const tracked = await git(repoRoot, ["diff", "HEAD"]);
    patch = tracked?.stdout ?? "";
    const untracked = await git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
    for (const rel of (untracked?.stdout ?? "").split("\0")) {
      if (!rel) continue;
      const src = path.join(repoRoot, rel);
      const dest = path.join(worktree, rel);
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      } catch {
        // best effort: a file that vanished mid-run isn't fatal
      }
    }
  }
  if (patch.trim() === "") return null; // nothing to apply

  const patchFile = path.join(worktree, ".keel-sandbox.patch");
  fs.writeFileSync(patchFile, patch.endsWith("\n") ? patch : patch + "\n");
  try {
    await execFileAsync("git", ["apply", "--whitespace=nowarn", patchFile], {
      cwd: worktree,
      maxBuffer: 64 * 1024 * 1024,
    });
    return null;
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "").trim();
    return `git apply failed${stderr ? `: ${stderr}` : " (diff does not apply to HEAD)"}`;
  } finally {
    fs.rmSync(patchFile, { force: true });
  }
}

function runnerCommand(runner: "vitest" | "jest" | "node", worktree: string, testFiles: string[], jsonFile: string): [string, string[]] {
  switch (runner) {
    case "vitest":
      return ["npx", ["--no-install", "vitest", "run", ...testFiles, "--reporter=json", `--outputFile=${jsonFile}`]];
    case "jest":
      return ["npx", ["--no-install", "jest", ...testFiles, "--json", `--outputFile=${jsonFile}`]];
    case "node":
      return [process.execPath, ["--test", ...testFiles]];
  }
}

/**
 * Run the selected Python tests under pytest in the worktree, returning normalized results.
 * pytest missing from the chosen interpreter is a clean "runner-unavailable" status naming it,
 * never a crash. Returns the result sans durationMs (the caller stamps it).
 */
async function runPytest(
  repoRoot: string,
  worktree: string,
  parent: string,
  ranTests: string[],
  timeoutMs: number,
  capped: { requested: number; ran: number } | undefined,
): Promise<Omit<SandboxResult, "durationMs">> {
  const interpreter = findPythonInterpreter(repoRoot);
  const cappedField = capped ? { capped } : {};

  // Is pytest importable via this interpreter? Check first, so a missing runner is a clean
  // status rather than a confusing "failed" from pytest's own "No module named pytest".
  const check = await runProcess(interpreter.cmd, ["-m", "pytest", "--version"], { cwd: worktree, timeoutMs: 30_000 });
  if (check.spawnError || check.code !== 0) {
    return {
      status: "runner-unavailable",
      runner: "pytest",
      ranTests,
      error: `pytest is not available via ${interpreter.label}${check.spawnError ? `: ${check.spawnError}` : ""} — install pytest (e.g. in the repo's .venv) to execute Python tests`,
      ...cappedField,
    };
  }

  // Put the worktree's module roots on PYTHONPATH so the change under test is imported (and takes
  // precedence over any installed copy) — the pytest analog of the node_modules symlink.
  const pythonPath = [...pythonModuleRoots(worktree), process.env["PYTHONPATH"]].filter(Boolean).join(path.delimiter);
  const junitFile = path.join(parent, "report.xml");
  const proc = await runProcess(
    interpreter.cmd,
    [
      "-m", "pytest", ...ranTests,
      `--junitxml=${junitFile}`,
      "-p", "no:cacheprovider", // core pytest, no plugins
      "--continue-on-collection-errors", // one broken sub-project can't abort the whole run
      "--color=no", // keep the output tail parseable (no ANSI)
    ],
    { cwd: worktree, timeoutMs, env: { PYTHONPATH: pythonPath } },
  );

  // Strip ANSI defensively before truncating, so the tail is clean even if a subprocess colorizes.
  const combined = tail(stripAnsi(`${proc.stdout}\n${proc.stderr}`));
  if (proc.timedOut) {
    return { status: "timed-out", runner: "pytest", ranTests, timedOut: true, exitCode: proc.code, ...(combined ? { output: combined } : {}), ...cappedField };
  }
  if (proc.spawnError) {
    return { status: "error", runner: "pytest", ranTests, error: proc.spawnError, ...(combined ? { output: combined } : {}), ...cappedField };
  }

  let results: ReturnType<typeof pytestResults> | null = null;
  try {
    results = pytestResults(fs.readFileSync(junitFile, "utf8"), worktree, ranTests);
  } catch {
    results = null;
  }

  // pytest exit codes: 0 ok, 1 tests failed, 2 collection error, 5 no tests collected.
  const status: RunStatus =
    results && results.total > 0
      ? results.failed > 0 ? "failed" : "passed"
      : proc.code === 5
        ? "no-tests"
        : proc.code === 0
          ? "passed"
          : "failed";

  // Never a silent "failed" with no detail: if the run failed but produced no parseable results
  // (e.g. a fatal conftest ImportError that pytest can't recover from), say the run itself failed
  // — the cleaned output tail carries the reason.
  const runFailedNoResults = status === "failed" && (!results || results.total === 0);

  return {
    status,
    runner: "pytest",
    ranTests,
    exitCode: proc.code,
    ...(runFailedNoResults ? { error: `the pytest run failed (exit ${proc.code ?? "?"}) without producing a report — see output` } : {}),
    ...(results ? { passed: results.passed, failed: results.failed, failures: results.failures } : {}),
    ...(combined ? { output: combined } : {}),
    ...cappedField,
  };
}

export async function runSandbox(repoRoot: string, options: SandboxOptions): Promise<SandboxResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTests = options.maxTests ?? DEFAULT_MAX_TESTS;
  const done = (r: Omit<SandboxResult, "durationMs">): SandboxResult => ({
    ...r,
    durationMs: Date.now() - started,
  });

  const head = await git(repoRoot, ["rev-parse", "HEAD"]);
  if (!head) return done({ status: "error", runner: null, ranTests: [], error: "no git HEAD to build a sandbox from" });

  const requested = options.testFiles;
  const ranTests = requested.slice(0, maxTests);
  const capped = ranTests.length < requested.length ? { requested: requested.length, ran: ranTests.length } : undefined;
  if (ranTests.length === 0) {
    return done({ status: "no-tests", runner: null, ranTests: [], ...(capped ? { capped } : {}) });
  }

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "keel-sandbox-"));
  const worktree = path.join(parent, "wt");
  // Tear down in order and awaited: remove the worktree (registration + dir), then rmSync
  // the parent as a fallback, then always prune so a failed remove can't leave a stale
  // entry in the main repo's .git/worktrees. Racing rmSync against a fire-and-forget remove
  // would let cleanup finish after the caller returns and orphan the registration.
  const cleanup = async (): Promise<void> => {
    await git(repoRoot, ["worktree", "remove", "--force", worktree]);
    try {
      fs.rmSync(parent, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    await git(repoRoot, ["worktree", "prune"]);
  };

  try {
    const added = await git(repoRoot, ["worktree", "add", "--detach", worktree, "HEAD"]);
    if (!added) return done({ status: "error", runner: null, ranTests, error: "could not create git worktree" });

    // Share deps without a reinstall: symlink node_modules if the main repo has it.
    const mainModules = path.join(repoRoot, "node_modules");
    if (fs.existsSync(mainModules) && !fs.existsSync(path.join(worktree, "node_modules"))) {
      try {
        fs.symlinkSync(mainModules, path.join(worktree, "node_modules"), "dir");
      } catch {
        /* tests may still run for zero-dep (node:test) repos */
      }
    }

    const applyError = await applyChange(repoRoot, worktree, options.diff);
    if (applyError) return done({ status: "apply-failed", runner: null, ranTests, error: applyError, ...(capped ? { capped } : {}) });

    // A change's covering tests are one language (no cross-language edges), so a Python selection
    // runs under pytest; anything else under the JS runners.
    if (ranTests.every(isPythonTest)) {
      return done(await runPytest(repoRoot, worktree, parent, ranTests, timeoutMs, capped));
    }

    const runner = detectRunner(worktree);
    const jsonFile = path.join(parent, "report.json");
    const [command, args] = runnerCommand(runner, worktree, ranTests, jsonFile);
    const proc = await runProcess(command, args, { cwd: worktree, timeoutMs });

    const combined = tail(`${proc.stdout}\n${proc.stderr}`);
    if (proc.timedOut) {
      return done({ status: "timed-out", runner, ranTests, timedOut: true, exitCode: proc.code, ...(combined ? { output: combined } : {}), ...(capped ? { capped } : {}) });
    }
    if (proc.spawnError) {
      return done({ status: "error", runner, ranTests, error: proc.spawnError, ...(combined ? { output: combined } : {}), ...(capped ? { capped } : {}) });
    }

    let structured: { passed: number; failed: number; failures: TestFailure[] } | null = null;
    if (runner !== "node") {
      try {
        structured = parseJestJson(fs.readFileSync(jsonFile, "utf8"), worktree);
      } catch {
        structured = null;
      }
    }

    const status: RunStatus = proc.code === 0 ? "passed" : "failed";
    return done({
      status,
      runner,
      ranTests,
      exitCode: proc.code,
      ...(structured
        ? { passed: structured.passed, failed: structured.failed, failures: structured.failures }
        : {}),
      ...(combined ? { output: combined } : {}),
      ...(capped ? { capped } : {}),
    });
  } finally {
    await cleanup();
  }
}
