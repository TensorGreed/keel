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
 * reusing the ci/junit parser); Go tests under `go test -json` (per package); otherwise, from
 * package.json, vitest or jest (JSON-reported, so failures are structured), else Node's built-in
 * `node --test`. No LLM, no network.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseJUnit } from "../ci/junit.js";
import { pythonModuleRoots } from "../graph/python-scanner.js";
import { IS_WINDOWS, linkDir, localPackageBin, resolveOnPath, spawnSpec, unlinkDir } from "../util/platform.js";
import { execFileTimed, PROGRESS_THRESHOLD_MS, runnerTimeoutMs } from "../util/timeouts.js";

const DEFAULT_MAX_TESTS = 50;
const MAX_CAPTURE_BYTES = 512 * 1024; // cap captured output so a chatty run can't OOM us
const OUTPUT_TAIL = 8_000;

export type Runner = "vitest" | "jest" | "node" | "pytest" | "go" | "mvn" | "gradle";

export type RunStatus =
  | "passed"
  | "failed"
  | "no-tests"
  | "apply-failed"
  | "timed-out"
  | "runner-unsupported"
  | "runner-unavailable"
  /** the runner exists but its environment couldn't be prepared (e.g. a Go toolchain download failed) */
  | "environment-error"
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
  /**
   * Share the main repo's node_modules by linking it into the worktree (default true). `keel
   * upgrade` turns this OFF: the whole point of that run is a DIFFERENT dependency tree, and a link
   * to the host's node_modules would silently test the version already installed.
   */
  linkNodeModules?: boolean;
  /**
   * Run after the worktree exists and the change is applied, before the runner is chosen — the seam
   * for a change that isn't expressible as a diff. `keel upgrade` uses it to rewrite package.json
   * and install; returning an error aborts the run with that status instead of running tests.
   *
   * It shares the run's wall-clock budget: whatever it consumes is deducted from the time left for
   * the tests, and the remaining budget is passed back in so it can bound its own subprocesses.
   */
  prepare?: (worktree: string, budgetMs: number) => Promise<PrepareResult>;
}

export interface PrepareResult {
  /** set to abort before running tests: the run ends with this status and error */
  error?: string;
  status?: RunStatus;
  /** captured output to fold into the result (an install log, say) */
  output?: string;
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
  // On Windows a build tool is usually a .cmd/.bat shim, which CreateProcess can't run and which
  // Node refuses to spawn without a shell; spawnSpec settles that (and pre-quotes for cmd.exe).
  const spec = spawnSpec(command, args);
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, {
      cwd: opts.cwd,
      shell: spec.shell,
      env: { ...process.env, CI: "true", FORCE_COLOR: "0", ...opts.env },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const capture = (chunk: Buffer, sink: "out" | "err"): void => {
      if (sink === "out" && stdout.length < MAX_CAPTURE_BYTES) stdout += chunk.toString();
      else if (sink === "err" && stderr.length < MAX_CAPTURE_BYTES) stderr += chunk.toString();
    };
    child.stdout.on("data", (c: Buffer) => capture(c, "out"));
    child.stderr.on("data", (c: Buffer) => capture(c, "err"));
    const progressTimer = setTimeout(() => {
      if (!settled) process.stderr.write(`[keel] still waiting: ${command} ${args.join(" ")}...\n`);
    }, PROGRESS_THRESHOLD_MS);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, opts.timeoutMs);
    child.on("error", (err) => {
      settled = true;
      clearTimeout(timer);
      clearTimeout(progressTimer);
      resolve({ stdout, stderr, code: null, timedOut, spawnError: err.message });
    });
    child.on("close", (code) => {
      settled = true;
      clearTimeout(timer);
      clearTimeout(progressTimer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}

/**
 * Kill a timed-out runner and everything it started. On POSIX a SIGKILL to the child is enough
 * for our purposes (the test runners we spawn don't outlive their parent). On Windows a batch
 * shim runs under cmd.exe, so killing the child would leave the real build (`java`, `go`, …)
 * running unbounded — which would break "no hangs, ever". `taskkill /T /F` takes the tree.
 */
function killTree(child: ReturnType<typeof spawn>): void {
  if (IS_WINDOWS && child.pid !== undefined) {
    const taskkill = resolveOnPath("taskkill");
    if (taskkill) {
      try {
        spawn(taskkill, ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).unref();
      } catch {
        /* fall through to the direct kill below */
      }
    }
  }
  child.kill("SIGKILL");
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string } | null> {
  try {
    return await execFileTimed("git", args, { cwd, maxBuffer: 256 * 1024 * 1024, label: `git ${args[0] ?? ""}` });
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

function isGoTest(file: string): boolean {
  return file.endsWith("_test.go");
}

function isJavaTest(file: string): boolean {
  return file.endsWith(".java");
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
 * linking node_modules — it carries the project's installed deps), else the interpreter on PATH.
 *
 * A venv puts its interpreter under `bin/python` on POSIX and `Scripts\python.exe` on Windows, so
 * both layouts are probed for each venv location. The PATH fallback is `python3` on POSIX but
 * `python` on Windows: `python3` there is usually absent, or a Microsoft Store stub that opens the
 * Store instead of running anything.
 */
function findPythonInterpreter(repoRoot: string): Interpreter {
  const venv = process.env["VIRTUAL_ENV"];
  const roots = [venv, path.join(repoRoot, ".venv"), path.join(repoRoot, "venv")].filter((p): p is string => Boolean(p));
  const candidates = roots.flatMap((r) => [path.join(r, "bin", "python"), path.join(r, "Scripts", "python.exe")]);
  for (const cmd of candidates) {
    if (isFile(cmd)) return { cmd, label: cmd.startsWith(repoRoot + path.sep) ? path.relative(repoRoot, cmd) : cmd };
  }
  const onPath = IS_WINDOWS ? "python" : "python3";
  return { cmd: onPath, label: onPath };
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
    // The trace: the <failure>/<error> text (a full traceback), or captured stdout as a fallback,
    // ANSI-stripped and line-capped — parity with the JS/Go runners, which also carry a trace.
    const rawTrace = t.details ?? t.systemOut;
    const trace = rawTrace ? capLines(stripAnsi(rawTrace).trim(), MAX_TRACE_LINES) : undefined;
    const withTrace = trace ? { trace } : {};
    const isCollectionError = t.status === "error" && (!t.classname || t.message === "collection failure");
    if (isCollectionError) {
      const message = exceptionLine(t.details) ?? t.message ?? "collection error";
      failures.push({ name: t.name || "(collection error)", ...(file ? { file } : {}), message, ...(trace && trace !== message ? withTrace : {}), kind: "collection-error" });
    } else {
      const message = (t.message ?? "(no message)").split("\n", 1)[0]!.trim() || "(no message)";
      failures.push({ name: t.name || "(unnamed test)", ...(file ? { file } : {}), message, ...(trace && trace !== message ? withTrace : {}) });
    }
  }
  return { passed, failed, failures, total: report.tests.length };
}

/** The junit report path that pairs with a runner's JSON report path (same dir, .xml). */
function junitPathFor(jsonFile: string): string {
  return jsonFile.replace(/\.json$/, ".junit.xml");
}

/**
 * Normalize Node's built-in junit reporter into sandbox counts + failures. Unlike pytest's report
 * this one carries an absolute `file` per case, so attribution needs no reconstruction — just the
 * repo-relative conversion every graph key uses.
 */
export function nodeTestResults(xml: string, worktree: string): { passed: number; failed: number; failures: TestFailure[] } {
  const report = parseJUnit(xml);
  let passed = 0;
  const failures: TestFailure[] = [];
  for (const t of report.tests) {
    if (t.status === "passed") {
      passed++;
      continue;
    }
    if (t.status === "skipped") continue;
    const file = t.file ? toRepoRel(worktree, t.file) : undefined;
    const message = (t.message ?? "(no message)").split("\n", 1)[0]!.trim() || "(no message)";
    const trace = t.details ? capLines(stripAnsi(t.details).trim(), MAX_TRACE_LINES) : undefined;
    failures.push({
      name: t.name || "(unnamed test)",
      ...(file ? { file } : {}),
      message,
      ...(trace && trace !== message ? { trace } : {}),
    });
  }
  return { passed, failed: failures.length, failures };
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
    await execFileTimed("git", ["apply", "--whitespace=nowarn", patchFile], {
      cwd: worktree,
      maxBuffer: 64 * 1024 * 1024,
      label: "git apply",
    });
    return null;
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "").trim();
    return `git apply failed${stderr ? `: ${stderr}` : " (diff does not apply to HEAD)"}`;
  } finally {
    fs.rmSync(patchFile, { force: true });
  }
}

/**
 * How to invoke the detected JS runner in the worktree.
 *
 * The runner is already installed (that's how detectRunner found it in package.json, and the
 * worktree shares the repo's node_modules), so we resolve its own JS entry from its `bin` field
 * and run it with `process.execPath`. That is identical on every platform — unlike `npx`, which
 * adds a process layer and is a `.cmd` shim on Windows, and unlike `node_modules/.bin/vitest`,
 * whose POSIX entry is a shebang script Windows cannot execute. `npx --no-install` stays as the
 * fallback for the odd layout where the bin field doesn't resolve.
 */
function runnerCommand(runner: "vitest" | "jest" | "node", worktree: string, testFiles: string[], jsonFile: string): [string, string[]] {
  if (runner === "node") {
    // Two reporters: `spec` to stdout so the output tail stays human-readable, and `junit` to a file
    // so failures come back STRUCTURED — name, file, message and stack — instead of just a non-zero
    // exit. Node's built-in junit reporter is available from the version keel already requires, and
    // the report goes through the same parser `keel ci` uses.
    return [
      process.execPath,
      [
        "--test",
        "--test-reporter=spec",
        "--test-reporter-destination=stdout",
        "--test-reporter=junit",
        `--test-reporter-destination=${junitPathFor(jsonFile)}`,
        ...testFiles,
      ],
    ];
  }
  const runnerArgs =
    runner === "vitest"
      ? ["run", ...testFiles, "--reporter=json", `--outputFile=${jsonFile}`]
      : [...testFiles, "--json", `--outputFile=${jsonFile}`];
  const bin = localPackageBin(worktree, runner, runner);
  return bin ? [process.execPath, [bin, ...runnerArgs]] : ["npx", ["--no-install", runner, ...runnerArgs]];
}

/** A conftest pytest reported as fatal to load, and the exception line to show for it. */
interface ConftestError {
  /** the conftest's directory subtree (repo-relative posix) — every test under it is unrunnable */
  dir: string;
  message: string;
}

/**
 * Conftests pytest failed to LOAD, parsed from a run's output. An ImportError while loading a
 * conftest.py is fatal to the whole pytest session regardless of --continue-on-collection-errors
 * (that flag only covers collection of test *modules*), so no junitxml is produced and the failure
 * is only visible in the output. pytest aborts on the first such conftest, so a run usually yields
 * one; each governs a directory subtree we can exclude and retry without.
 */
function parseConftestLoadErrors(cleanOutput: string, worktree: string): ConftestError[] {
  const re = /while loading conftest ['"]([^'"]+)['"]/g;
  const errors: ConftestError[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleanOutput)) !== null) {
    const dir = path.posix.dirname(toRepoRel(worktree, m[1]!)); // the conftest's directory subtree
    if (seen.has(dir)) continue;
    seen.add(dir);
    // The exception ("E   ModuleNotFoundError: ...") lives between this header and the next.
    const next = cleanOutput.indexOf("while loading conftest", re.lastIndex);
    const block = cleanOutput.slice(m.index, next === -1 ? undefined : next);
    errors.push({ dir, message: exceptionLine(block) ?? "conftest import failed" });
  }
  return errors;
}

/** Whether a selected test file lives under a conftest's directory subtree. */
function underSubtree(testFile: string, dir: string): boolean {
  return dir === "." || testFile === dir || testFile.startsWith(dir + "/");
}

/**
 * Run the selected Python tests under pytest in the worktree, returning normalized results.
 * pytest missing from the chosen interpreter is a clean "runner-unavailable" status naming it,
 * never a crash. Returns the result sans durationMs (the caller stamps it).
 *
 * A conftest.py that fails to import aborts the entire session (see parseConftestLoadErrors), so
 * one broken example sub-project would otherwise sink the whole run with an empty result. We defend
 * with a bounded exclude-and-retry loop: detect the offending conftest, record a collection-error
 * for every selected test under its subtree, and re-run with the rest. At most 3 retries, each of
 * which provably removes ≥1 subtree (pytest only loads a conftest that governs a selected test);
 * the wall-time budget is cumulative across retries.
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
  const MAX_RETRIES = 3;

  let remaining = [...ranTests];
  const excluded: TestFailure[] = []; // tests under a broken conftest — recorded, not executed
  const outputs: string[] = [];
  let executed: ReturnType<typeof pytestResults> | null = null;
  let lastCode: number | null = null;
  let budgetMs = timeoutMs;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (remaining.length === 0 || budgetMs <= 0) break;

    const junitFile = path.join(parent, `report.${attempt}.xml`);
    const start = Date.now();
    const proc = await runProcess(
      interpreter.cmd,
      [
        "-m", "pytest", ...remaining,
        `--junitxml=${junitFile}`,
        "-p", "no:cacheprovider", // core pytest, no plugins
        "--continue-on-collection-errors", // recoverable collection errors don't abort the run
        "--color=no", // keep the output tail parseable (no ANSI)
      ],
      { cwd: worktree, timeoutMs: budgetMs, env: { PYTHONPATH: pythonPath } },
    );
    budgetMs -= Date.now() - start;
    lastCode = proc.code;
    const clean = stripAnsi(`${proc.stdout}\n${proc.stderr}`);
    outputs.push(clean);

    if (proc.timedOut) {
      // We only keep `executed` results at a terminal break, so none exist yet here; still report
      // any conftests already excluded so the timeout doesn't erase that honesty.
      return { status: "timed-out", runner: "pytest", ranTests, timedOut: true, exitCode: proc.code, passed: 0, failed: excluded.length, failures: [...excluded], ...withOutput(outputs), ...cappedField };
    }
    if (proc.spawnError) {
      return { status: "error", runner: "pytest", ranTests, error: proc.spawnError, ...withOutput(outputs), ...cappedField };
    }

    let results: ReturnType<typeof pytestResults> | null = null;
    try {
      results = pytestResults(fs.readFileSync(junitFile, "utf8"), worktree, remaining);
    } catch {
      results = null;
    }
    if (results && results.total > 0) {
      executed = results; // the session completed (no fatal conftest) — terminal
      break;
    }

    // No parseable results: a fatal conftest abort, no tests collected, or an opaque failure.
    const conftests = parseConftestLoadErrors(clean, worktree);
    if (conftests.length === 0) {
      executed = results; // not a conftest abort — terminal (no-tests / opaque failure)
      break;
    }

    // Record every selected test under a broken conftest as a collection error, and drop it. Each
    // detected conftest governs ≥1 selected test (pytest wouldn't have loaded it otherwise), so this
    // removes ≥1 — provable progress. On the last allowed attempt we still record, then stop.
    let removedAny = false;
    for (const { dir, message } of conftests) {
      const under = remaining.filter((t) => underSubtree(t, dir));
      if (under.length === 0) continue;
      removedAny = true;
      for (const t of under) excluded.push({ name: path.posix.basename(t), file: t, message, kind: "collection-error" });
      remaining = remaining.filter((t) => !underSubtree(t, dir));
    }
    if (!removedAny) break; // no subtree matched — can't make progress, stop rather than spin
  }

  const realFailures = executed?.failures ?? [];
  const passed = executed?.passed ?? 0;
  const failures = [...realFailures, ...excluded];
  const executedTotal = executed?.total ?? 0;

  // Status reflects the executed tests' outcome; a collection error is a failure (as pytest's own
  // collection errors already are). By construction, "failed" implies a non-empty failures list —
  // and the residual opaque case (no results, no conftest, non-zero exit) still carries an error.
  const status: RunStatus =
    failures.length > 0 ? "failed"
    : executedTotal > 0 ? "passed"
    : lastCode === 5 ? "no-tests"
    : lastCode === 0 ? "passed"
    : "failed";
  const failedNoResults = status === "failed" && failures.length === 0;

  return {
    status,
    runner: "pytest",
    ranTests,
    exitCode: lastCode,
    ...(failedNoResults ? { error: `the pytest run failed (exit ${lastCode ?? "?"}) without producing a report — see output` } : {}),
    passed,
    failed: failures.length,
    failures,
    ...withOutput(outputs),
    ...cappedField,
  };
}

/** The cleaned, capped tail of one or more run outputs, as a spreadable `{ output }` (or `{}`). */
function withOutput(outputs: string[]): { output?: string } {
  const combined = tail(outputs.join("\n"));
  return combined ? { output: combined } : {};
}

interface GoEvent {
  Action?: string;
  Package?: string;
  Test?: string;
  Output?: string;
}

/** Signatures of a Go toolchain resolution/download failure (GOTOOLCHAIN), distinct from a build
 *  or test failure — the run never got far enough to compile the change. */
const GO_TOOLCHAIN_ERROR_RE = /GOTOOLCHAIN|go\.mod requires go|requires go >=|cannot load toolchain|downloading go\d|toolchain\/download|go: download|switching to go/i;

/** The concrete failure line from a Go test's captured output — the `file.go:line: message`
 *  assertion or panic — skipping go test's `=== RUN` / `--- FAIL` framing. */
function goFailureMessage(output: string): string {
  const line = output
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("=== ") && !l.startsWith("--- ") && l !== "PASS" && l !== "FAIL");
  return line ?? "(test failed)";
}

/**
 * Run the selected Go tests in the worktree. Go tests run per PACKAGE, not per file, so the
 * selected `_test.go` files are mapped to their package dirs and run in one `go test -json` pass;
 * each package's results are attributed back to one of its selected test files, keeping the graph
 * path to the change. The go toolchain builds the package before testing, so a compile error IS
 * the executed result — it surfaces as a failure carrying the compiler output, never a runner
 * crash. go absent is a clean "runner-unavailable" naming what was tried. Result sans durationMs.
 */
async function runGoTest(
  worktree: string,
  ranTests: string[],
  timeoutMs: number,
  capped: { requested: number; ran: number } | undefined,
): Promise<Omit<SandboxResult, "durationMs">> {
  const cappedField = capped ? { capped } : {};

  // Is the go toolchain available? Check first, so a missing runner is a clean status rather than a
  // confusing spawn error.
  const check = await runProcess("go", ["version"], { cwd: worktree, timeoutMs: 30_000 });
  if (check.spawnError || check.code !== 0) {
    return {
      status: "runner-unavailable",
      runner: "go",
      ranTests,
      error: `the go toolchain is not available${check.spawnError ? `: ${check.spawnError}` : ""} — install Go to execute \`go test\``,
      ...cappedField,
    };
  }

  // Map selected _test.go files to their package dirs (Go runs tests per package). Remember one
  // test file per package basename so a failure can be attributed back to a file in the change.
  const pkgArgs = new Set<string>();
  const testFileForBasename = new Map<string, string>();
  for (const t of ranTests) {
    const dir = path.posix.dirname(t);
    pkgArgs.add(dir === "." ? "." : `./${dir}`);
    const base = dir === "." ? "." : path.posix.basename(dir);
    if (!testFileForBasename.has(base)) testFileForBasename.set(base, t);
  }
  // A -json event names its package by import path; its last segment is the package dir's basename.
  const attributeFile = (pkgImportPath: string | undefined): string | undefined =>
    testFileForBasename.get((pkgImportPath ?? "").split("/").pop() ?? "") ?? ranTests[0];

  const proc = await runProcess("go", ["test", "-json", "-run", ".", ...pkgArgs], { cwd: worktree, timeoutMs });
  const combined = tail(stripAnsi(`${proc.stdout}\n${proc.stderr}`));
  if (proc.timedOut) {
    return { status: "timed-out", runner: "go", ranTests, timedOut: true, exitCode: proc.code, ...(combined ? { output: combined } : {}), ...cappedField };
  }
  if (proc.spawnError) {
    return { status: "error", runner: "go", ranTests, error: proc.spawnError, ...(combined ? { output: combined } : {}), ...cappedField };
  }

  // Parse the -json event stream. A test-level pass/fail carries a Test field; a package that fails
  // to compile emits output lines then a package-level fail (no Test) — that's the build error.
  let passed = 0;
  const failingTests: { pkg: string; test: string }[] = [];
  const failedPackages = new Set<string>();
  const testOutput = new Map<string, string>();
  const pkgOutput = new Map<string, string>();
  const key = (pkg: string | undefined, test: string): string => `${pkg ?? ""} ${test}`;

  for (const line of proc.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: GoEvent;
    try {
      ev = JSON.parse(trimmed) as GoEvent;
    } catch {
      continue; // non-JSON noise (already in the output tail)
    }
    if (ev.Action === "output" && ev.Output) {
      const map = ev.Test ? testOutput : pkgOutput;
      const k = ev.Test ? key(ev.Package, ev.Test) : ev.Package ?? "";
      map.set(k, (map.get(k) ?? "") + ev.Output);
    } else if (ev.Action === "pass" && ev.Test) {
      passed++;
    } else if (ev.Action === "fail" && ev.Test) {
      failingTests.push({ pkg: ev.Package ?? "", test: ev.Test });
    } else if (ev.Action === "fail" && !ev.Test && ev.Package) {
      failedPackages.add(ev.Package);
    }
  }

  const failures: TestFailure[] = [];
  const failedTestPackages = new Set<string>();
  for (const { pkg, test } of failingTests) {
    failedTestPackages.add(pkg);
    const out = capLines(stripAnsi((testOutput.get(key(pkg, test)) ?? "").trim()), MAX_TRACE_LINES);
    const message = goFailureMessage(out);
    const file = attributeFile(pkg);
    failures.push({ name: test, ...(file ? { file } : {}), message, ...(out && out !== message ? { trace: out } : {}) });
  }
  // A package that failed with no failing test is a build/compile failure (or a package-level panic
  // before any test ran) — the go build executed, so surface it as a failure with the compiler
  // output rather than hiding it as a crash.
  for (const pkg of failedPackages) {
    if (failedTestPackages.has(pkg)) continue;
    const out = capLines(stripAnsi((pkgOutput.get(pkg) ?? "").trim()), MAX_TRACE_LINES);
    const file = attributeFile(pkg);
    failures.push({ name: `${pkg} (build failed)`, ...(file ? { file } : {}), message: goFailureMessage(out) || "build failed", ...(out ? { trace: out } : {}) });
  }

  const failed = failures.length;
  const total = passed + failed;

  // `go version` reports the local toolchain, but `go test` reads go.mod's `go` directive and may
  // try to fetch a newer toolchain (GOTOOLCHAIN=auto). When that resolution/download fails, the run
  // produced no test or build result — that's an environment fault, not the change's or a missing
  // runner. Report it as such, carrying go's own message, rather than a misleading "failed".
  if (total === 0 && proc.code !== 0 && GO_TOOLCHAIN_ERROR_RE.test(`${proc.stdout}\n${proc.stderr}`)) {
    const stderr = stripAnsi(proc.stderr).trim();
    return {
      status: "environment-error",
      runner: "go",
      ranTests,
      error: `the go toolchain could not be prepared${stderr ? `: ${stderr.split("\n", 1)[0]}` : ""} — check GOTOOLCHAIN / network`,
      exitCode: proc.code,
      ...(combined ? { output: combined } : {}),
      ...cappedField,
    };
  }

  const status: RunStatus = total > 0 ? (failed > 0 ? "failed" : "passed") : proc.code === 0 ? "no-tests" : "failed";
  const runFailedNoResults = status === "failed" && total === 0;

  return {
    status,
    runner: "go",
    ranTests,
    exitCode: proc.code,
    ...(runFailedNoResults ? { error: `the go test run failed (exit ${proc.code ?? "?"}) without reporting a test or build error — see output` } : {}),
    passed,
    failed,
    failures,
    ...(combined ? { output: combined } : {}),
    ...cappedField,
  };
}

// --- Java: mvn / gradle ----------------------------------------------------

/** A build-bootstrap fault — the build never got far enough to compile the change: dependency or
 *  plugin RESOLUTION failure, a repository it couldn't reach (403/401, unknown host, timeout, TLS),
 *  a missing JDK, or a wrapper that couldn't fetch its distribution. Distinct from a source compile
 *  error and checked first, so an environment problem isn't mislabelled a compilation failure. */
const JAVA_ENV_ERROR_RE = new RegExp(
  [
    "Could not resolve", // Maven: "Could not resolve dependencies" OR "... plugin ..."
    "Could not (?:download|transfer|find|GET) ",
    "Could not (?:read|collect) dependencies",
    "\\b(?:Plugin|Artifact|Dependency)ResolutionException\\b",
    "Cannot access .* in offline mode",
    "Non-resolvable",
    "status code: 40[0-9]", // an HTTP error from the artifact repository (403 proxy/auth, 401, 404)
    "UnknownHostException", "Unknown host",
    "Connection (?:refused|timed out)", "Read timed out", "PKIX path", "SSLHandshakeException",
    "JAVA_HOME", "Unable to locate a Java Runtime", "No compiler is provided", "tools\\.jar",
    "Could not determine java version", "requires Java", "Could not create service",
    "Unsupported class file major version",
    "Could not (?:install|download) Gradle distribution", "Network is unreachable",
  ].join("|"),
  "i",
);
/** A source compilation failure — an executed result (the build compiled the change and it failed),
 *  surfaced as a failure carrying the compiler output, same rule as Go. */
const JAVA_COMPILE_ERROR_RE = /COMPILATION ERROR|compileJava\w* FAILED|cannot find symbol|error: (?:cannot|incompatible|method|class )|';' expected|reached end of file/i;

/**
 * Classify a build tool's output when it failed and produced NO test report: an environment fault
 * (dependency/plugin resolution, unreachable repository, missing JDK) or a source compile error, or
 * null if neither signature is present. Pure — used by runJavaTest and unit-tested on recorded
 * output so the taxonomy is pinned without a network or a build tool.
 */
export function classifyJavaBuildFailure(output: string): "environment-error" | "compile-error" | null {
  if (JAVA_ENV_ERROR_RE.test(output)) return "environment-error";
  if (JAVA_COMPILE_ERROR_RE.test(output)) return "compile-error";
  return null;
}

/** A selected test file → its fully-qualified class name (dir under src/{test,main}/java, dotted). */
export function javaClassName(relFile: string): string {
  const m = /src\/(?:test|main)\/java\/(.+)\.java$/.exec(relFile);
  return m ? m[1]!.split("/").join(".") : path.posix.basename(relFile, ".java");
}

interface JavaBuild {
  tool: "mvn" | "gradle";
  cmd: string;
  label: string;
  /** true when cmd is a repo wrapper (./mvnw, ./gradlew) rather than a global install */
  wrapper: boolean;
}

/** The build tool for the worktree: Maven if there's a pom, else Gradle; a repo wrapper preferred
 *  over a global install (it pins the tool version). null when neither is present. */
function detectJavaBuild(worktree: string): JavaBuild | null {
  const wrapperName = process.platform === "win32" ? { mvn: "mvnw.cmd", gradle: "gradlew.bat" } : { mvn: "mvnw", gradle: "gradlew" };
  const hasPom = isFile(path.join(worktree, "pom.xml"));
  const hasGradle = ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"].some((f) => isFile(path.join(worktree, f)));
  const mvnw = path.join(worktree, wrapperName.mvn);
  const gradlew = path.join(worktree, wrapperName.gradle);
  if (hasPom || isFile(mvnw)) {
    return isFile(mvnw) ? { tool: "mvn", cmd: mvnw, label: `./${wrapperName.mvn}`, wrapper: true } : { tool: "mvn", cmd: "mvn", label: "mvn", wrapper: false };
  }
  if (hasGradle || isFile(gradlew)) {
    return isFile(gradlew) ? { tool: "gradle", cmd: gradlew, label: `./${wrapperName.gradle}`, wrapper: true } : { tool: "gradle", cmd: "gradle", label: "gradle", wrapper: false };
  }
  return null;
}

/** Read every JUnit XML the build tool wrote: Surefire (Maven) or test-results (Gradle). `build`/
 *  `target` hold these, so we walk without the graph's IGNORED_DIRS filter (which excludes `build`). */
function readJavaReports(worktree: string, tool: "mvn" | "gradle"): string[] {
  const wanted = tool === "mvn" ? path.join("target", "surefire-reports") : path.join("build", "test-results", "test");
  const xmls: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== ".git" && e.name !== "node_modules") walk(full);
      } else if (e.isFile() && e.name.startsWith("TEST-") && e.name.endsWith(".xml") && dir.endsWith(wanted)) {
        try {
          xmls.push(fs.readFileSync(full, "utf8"));
        } catch {
          /* a report that vanished mid-run isn't fatal */
        }
      }
    }
  };
  walk(worktree);
  return xmls;
}

/** Normalize the build tool's JUnit reports into sandbox counts + failures, attributing each failure
 *  back to its selected test file (via the JUnit `classname`) so it keeps a graph path to the change. */
export function javaResults(
  xmls: string[],
  fileForClass: Map<string, string>,
): { passed: number; failed: number; failures: TestFailure[]; total: number } {
  let passed = 0;
  const failures: TestFailure[] = [];
  for (const xml of xmls) {
    for (const t of parseJUnit(xml).tests) {
      if (t.status === "passed") {
        passed++;
        continue;
      }
      if (t.status === "skipped") continue;
      const file = t.classname ? fileForClass.get(t.classname) : undefined;
      const message = (t.message ?? "(no message)").split("\n", 1)[0]!.trim() || "(no message)";
      const rawTrace = t.details ?? t.systemOut;
      const trace = rawTrace ? capLines(stripAnsi(rawTrace).trim(), MAX_TRACE_LINES) : undefined;
      failures.push({ name: t.name || "(unnamed test)", ...(file ? { file } : {}), message, ...(trace && trace !== message ? { trace } : {}) });
    }
  }
  return { passed, failed: failures.length, failures, total: passed + failures.length };
}

/**
 * Run the selected Java tests via the project's build tool (Maven or Gradle), returning normalized
 * results. Tests run per CLASS: the selected files map to fully-qualified class names and run in one
 * `mvn -Dtest=A,B test` / `gradle test --tests A --tests B` invocation. Results come from the
 * Surefire / Gradle JUnit XML — the same parser `keel ci` uses. These builds are slow, so the whole
 * build+test runs under one wall-time budget and the output tail is truncated honestly.
 *
 * A source compile error is an executed result (like Go): surfaced as a failure with the compiler
 * output, never a crash. No build tool → runner-unavailable naming what was tried; a toolchain or
 * dependency-resolution fault → environment-error (same taxonomy as Go). Result sans durationMs.
 */
async function runJavaTest(
  worktree: string,
  ranTests: string[],
  timeoutMs: number,
  capped: { requested: number; ran: number } | undefined,
): Promise<Omit<SandboxResult, "durationMs">> {
  const cappedField = capped ? { capped } : {};
  const build = detectJavaBuild(worktree);
  if (!build) {
    return {
      status: "runner-unavailable",
      runner: null,
      ranTests,
      error: "no Java build tool found (looked for ./mvnw, ./gradlew, mvn, gradle) — add a wrapper or install Maven/Gradle to execute Java tests",
      ...cappedField,
    };
  }
  // A global tool (not a wrapper) must be on PATH; a wrapper bootstraps itself.
  if (!build.wrapper) {
    const check = await runProcess(build.cmd, ["-version"], { cwd: worktree, timeoutMs: 60_000 });
    if (check.spawnError || check.code !== 0) {
      return {
        status: "runner-unavailable",
        runner: build.tool,
        ranTests,
        error: `${build.label} is not available${check.spawnError ? `: ${check.spawnError}` : ""} — install it or add a ${build.tool === "mvn" ? "./mvnw" : "./gradlew"} wrapper to execute Java tests`,
        ...cappedField,
      };
    }
  }

  const classes = [...new Set(ranTests.map(javaClassName))];
  const fileForClass = new Map<string, string>();
  for (const t of ranTests) fileForClass.set(javaClassName(t), fileForClass.get(javaClassName(t)) ?? t);

  const args =
    build.tool === "mvn"
      ? ["-B", `-Dtest=${classes.join(",")}`, "-DfailIfNoTests=false", "test"]
      : ["test", ...classes.flatMap((c) => ["--tests", c]), "--console=plain"];
  const proc = await runProcess(build.cmd, args, { cwd: worktree, timeoutMs });
  const combined = tail(stripAnsi(`${proc.stdout}\n${proc.stderr}`));
  if (proc.timedOut) {
    return { status: "timed-out", runner: build.tool, ranTests, timedOut: true, exitCode: proc.code, ...(combined ? { output: combined } : {}), ...cappedField };
  }
  if (proc.spawnError) {
    return { status: "error", runner: build.tool, ranTests, error: proc.spawnError, ...(combined ? { output: combined } : {}), ...cappedField };
  }

  const results = javaResults(readJavaReports(worktree, build.tool), fileForClass);
  const output = `${proc.stdout}\n${proc.stderr}`;

  // No test results + a failing build: classify honestly. A build-bootstrap fault (missing JDK, an
  // unresolved dependency/plugin, an unreachable repository) never compiled the change — that's an
  // environment error, not the change's fault; a genuine source compile error IS the executed result.
  if (results.total === 0 && proc.code !== 0) {
    const kind = classifyJavaBuildFailure(output);
    if (kind === "environment-error") {
      return {
        status: "environment-error",
        runner: build.tool,
        ranTests,
        error: `the Java build environment could not be prepared: ${firstErrorLine(output)}`,
        exitCode: proc.code,
        ...(combined ? { output: combined } : {}),
        ...cappedField,
      };
    }
    if (kind === "compile-error") {
      const trace = capLines(stripAnsi(output).trim(), MAX_TRACE_LINES);
      return {
        status: "failed",
        runner: build.tool,
        ranTests,
        exitCode: proc.code,
        passed: 0,
        failed: 1,
        failures: [{ name: "(compilation failed)", ...(ranTests[0] ? { file: ranTests[0] } : {}), message: "the Java sources failed to compile", trace }],
        ...(combined ? { output: combined } : {}),
        ...cappedField,
      };
    }
  }

  const status: RunStatus = results.total > 0 ? (results.failed > 0 ? "failed" : "passed") : proc.code === 0 ? "no-tests" : "failed";
  const failedNoResults = status === "failed" && results.failures.length === 0;
  return {
    status,
    runner: build.tool,
    ranTests,
    exitCode: proc.code,
    ...(failedNoResults ? { error: `the ${build.label} run failed (exit ${proc.code ?? "?"}) without producing a test report — see output` } : {}),
    passed: results.passed,
    failed: results.failed,
    failures: results.failures,
    ...(combined ? { output: combined } : {}),
    ...cappedField,
  };
}

/** The first line of build output that looks like an error — for a one-line env-error summary. */
function firstErrorLine(output: string): string {
  const line = stripAnsi(output)
    .split("\n")
    .map((l) => l.replace(/^\[[A-Z]+\]\s*/, "").trim()) // drop Maven's [ERROR]/[INFO] prefixes
    .find((l) => JAVA_ENV_ERROR_RE.test(l));
  return line || "see output";
}

/** Concatenate a prepare log ahead of a runner's output, dropping either if empty. */
function joinOutput(prepared: string | undefined, runner: string): string {
  return [prepared, runner].filter((s) => s && s.trim() !== "").join("\n");
}

/** Prepend the prepare log to a language runner's result, so an install's output isn't lost. */
function withPrepareOutput(result: Omit<SandboxResult, "durationMs">, prepared: string | undefined): Omit<SandboxResult, "durationMs"> {
  if (!prepared || prepared.trim() === "") return result;
  const combined = tail(joinOutput(prepared, result.output ?? ""));
  return { ...result, ...(combined ? { output: combined } : {}) };
}

export async function runSandbox(repoRoot: string, options: SandboxOptions): Promise<SandboxResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? runnerTimeoutMs();
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
  const linkedModules = path.join(worktree, "node_modules");
  // Tear down in order and awaited: drop the node_modules link explicitly (so nothing recursive
  // can follow it into the main repo's real tree — a junction in particular is rmdir-shaped, not
  // unlink-shaped), remove the worktree (registration + dir), then rmSync the parent as a
  // fallback, then always prune so a failed remove can't leave a stale entry in the main repo's
  // .git/worktrees. Racing rmSync against a fire-and-forget remove would let cleanup finish after
  // the caller returns and orphan the registration.
  const cleanup = async (): Promise<void> => {
    unlinkDir(linkedModules);
    await git(repoRoot, ["worktree", "remove", "--force", worktree]);
    try {
      fs.rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* ignore */
    }
    await git(repoRoot, ["worktree", "prune"]);
  };

  try {
    const added = await git(repoRoot, ["worktree", "add", "--detach", worktree, "HEAD"]);
    if (!added) return done({ status: "error", runner: null, ranTests, error: "could not create git worktree" });

    // Share deps without a reinstall: link node_modules if the main repo has it. A failure isn't
    // fatal — tests may still run for a zero-dep (node:test) repo. Skipped when the caller is about
    // to install its own tree (see linkNodeModules), where the link would test the wrong versions.
    const mainModules = path.join(repoRoot, "node_modules");
    if ((options.linkNodeModules ?? true) && fs.existsSync(mainModules) && !fs.existsSync(linkedModules)) {
      linkDir(mainModules, linkedModules);
    }

    const applyError = await applyChange(repoRoot, worktree, options.diff);
    if (applyError) return done({ status: "apply-failed", runner: null, ranTests, error: applyError, ...(capped ? { capped } : {}) });

    // The prepare seam: a change that isn't a diff (a dependency install, say). It spends from the
    // same wall-clock budget, so what it takes is not available to the tests.
    let prepareOutput: string | undefined;
    let budgetMs = timeoutMs;
    if (options.prepare) {
      const startedPrepare = Date.now();
      const prepared = await options.prepare(worktree, budgetMs);
      budgetMs = Math.max(0, budgetMs - (Date.now() - startedPrepare));
      prepareOutput = prepared.output;
      if (prepared.error !== undefined) {
        return done({
          status: prepared.status ?? "error",
          runner: null,
          ranTests,
          error: prepared.error,
          ...(prepared.output ? { output: tail(prepared.output) } : {}),
          ...(capped ? { capped } : {}),
        });
      }
    }

    // A change's covering tests are one language (no cross-language edges), so a Python selection
    // runs under pytest, a Go selection under `go test`, a Java selection under mvn/gradle; anything
    // else under the JS runners.
    if (ranTests.every(isPythonTest)) {
      return done(withPrepareOutput(await runPytest(repoRoot, worktree, parent, ranTests, budgetMs, capped), prepareOutput));
    }
    if (ranTests.every(isGoTest)) {
      return done(withPrepareOutput(await runGoTest(worktree, ranTests, budgetMs, capped), prepareOutput));
    }
    if (ranTests.every(isJavaTest)) {
      return done(withPrepareOutput(await runJavaTest(worktree, ranTests, budgetMs, capped), prepareOutput));
    }

    const runner = detectRunner(worktree);
    const jsonFile = path.join(parent, "report.json");
    const [command, args] = runnerCommand(runner, worktree, ranTests, jsonFile);
    const proc = await runProcess(command, args, { cwd: worktree, timeoutMs: budgetMs });

    const combined = tail(joinOutput(prepareOutput, `${proc.stdout}\n${proc.stderr}`));
    if (proc.timedOut) {
      return done({ status: "timed-out", runner, ranTests, timedOut: true, exitCode: proc.code, ...(combined ? { output: combined } : {}), ...(capped ? { capped } : {}) });
    }
    if (proc.spawnError) {
      return done({ status: "error", runner, ranTests, error: proc.spawnError, ...(combined ? { output: combined } : {}), ...(capped ? { capped } : {}) });
    }

    let structured: { passed: number; failed: number; failures: TestFailure[] } | null = null;
    try {
      structured =
        runner === "node"
          ? nodeTestResults(fs.readFileSync(junitPathFor(jsonFile), "utf8"), worktree)
          : parseJestJson(fs.readFileSync(jsonFile, "utf8"), worktree);
    } catch {
      structured = null; // no report written (a crash before any test ran) — the output tail stands in
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
