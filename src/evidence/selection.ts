/**
 * Fault injection: does keel's test selection actually catch what breaks?
 *
 * ## The question
 *
 * `select_tests` claims that of 840 tests, these 12 are the ones that matter for a change. That
 * claim is the foundation of `preflight`, `verdict` and `keel upgrade` — and until now nothing
 * measured it. This harness measures it the only way that means anything: break something, run the
 * WHOLE suite to find out what really fails, and check whether keel's selection contained it.
 *
 * Two numbers come out, and they trade against each other:
 *
 *   - **Escape rate** — a test failed that keel did not select. This is the number that matters. An
 *     escape means `preflight` would have reported green on a change that breaks the build, which is
 *     worse than having no selection at all, because someone trusted it.
 *   - **Selectivity** — the share of the suite keel skipped. This is the benefit; it is only worth
 *     anything while the escape rate is zero.
 *
 * ## Why trials get discarded
 *
 * A trial only carries signal when the full suite *noticed* the fault. If nothing failed, the fault
 * is in code the suite doesn't cover, and keel cannot be blamed for failing to select a test that
 * would not have caught it either. Those are reported separately as `undetected` — a fact about the
 * repo's coverage, not about keel — and excluded from the escape-rate denominator. Counting them
 * would flatter keel; hiding them would overstate how much was measured.
 *
 * A trial is also discarded when the runner produced no per-test detail at all (`collapsed`) — there
 * is nothing to compare a selection against. Note what is deliberately NOT discarded: a fault that
 * makes a great many tests fail. The first version of this harness threw those away as "the fault
 * broke the build", which quietly biased the measurement in keel's favour — a change that breaks
 * 90 test files when keel selected 40 is the single most important escape there is, and it was
 * being classified as noise. If keel claims a change can only affect these tests, every test that
 * fails outside that set counts, whatever the mechanism.
 *
 * ## Scope
 *
 * JS/TS suites only, today: `runJsTests` is the oracle, so a pytest or `go test` repo has nothing
 * this can measure against. That is a stated limitation rather than a silent one — a run on such a
 * repo errors out saying so, instead of reporting a selectivity figure computed from a suite it
 * never executed.
 *
 * ## How it runs
 *
 * ONE git worktree at HEAD for the whole run, reused across trials — the mutation is written into
 * it and reverted after each. The user's working tree is never touched, and the expensive setup
 * (node_modules, a build) is paid once rather than per trial. Tests execute through the same
 * `runJsTests` path preflight uses, because a measurement of selection that measured a different
 * runner would prove nothing about the tool people actually run.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadGraph } from "../graph/cache.js";
import { isTestFile, selectTests } from "../simulate/select-tests.js";
import { runJsTests } from "../simulate/sandbox.js";
import { linkDir, unlinkDir } from "../util/platform.js";
import { execFileTimed } from "../util/timeouts.js";
import { mutate, sequence, type Mutation } from "./mutate.js";

const DEFAULT_TRIALS = 20;
const DEFAULT_SEED = 1;
const DEFAULT_TIMEOUT_MS = 600_000;

export type TrialOutcome =
  /** the suite caught the fault, and keel's selection contained every failing test */
  | "caught"
  /** the suite caught it, and at least one failing test was NOT selected — a miss */
  | "escaped"
  /** the suite didn't notice: the fault is in code no test covers */
  | "undetected"
  /** the fault took down most of the suite; no signal about selection */
  | "collapsed"
  /** the file offered no mutable site, or the run couldn't be completed */
  | "skipped";

export interface Trial {
  file: string;
  outcome: TrialOutcome;
  mutation?: { line: number; from: string; to: string };
  /** tests keel selected for a change to this file */
  selected: number;
  /** test files that actually failed under the fault */
  failed: string[];
  /** failing test files keel did NOT select — the escapes */
  escapes: string[];
  reason?: string;
  durationMs: number;
}

export interface SelectionEvidence {
  repo: string;
  head: string | null;
  seed: number;
  /** test files a runner would actually execute — the denominator for selectivity */
  totalTests: number;
  trials: Trial[];
  summary: {
    /** trials where the suite caught the fault: the only ones that measure selection */
    measured: number;
    caught: number;
    escaped: number;
    undetected: number;
    collapsed: number;
    skipped: number;
    /** escaped / measured, or null when nothing was measurable */
    escapeRate: number | null;
    /** mean share of the suite keel skipped, over measured trials */
    selectivity: number | null;
    /** mean tests selected, over measured trials */
    meanSelected: number | null;
  };
  notes: string[];
  durationMs: number;
}

export interface SelectionOptions {
  trials?: number;
  seed?: number;
  /** per-trial wall clock for the full suite */
  timeoutMs?: number;
  /** restrict candidate files to those starting with one of these prefixes */
  include?: string[];
  onTrial?: (trial: Trial, index: number, total: number) => void;
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileTimed("git", args, { cwd, maxBuffer: 64 * 1024 * 1024, label: `git ${args[0]}` });
    return stdout;
  } catch {
    return null;
  }
}

export async function measureSelection(
  repoRoot: string,
  options: SelectionOptions = {},
): Promise<SelectionEvidence | { error: string }> {
  const started = Date.now();
  const root = path.resolve(repoRoot);
  const trialCount = options.trials ?? DEFAULT_TRIALS;
  const seed = options.seed ?? DEFAULT_SEED;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const notes: string[] = [];

  const head = (await git(root, ["rev-parse", "HEAD"]))?.trim() ?? null;
  if (head === null) return { error: "not a git repo (or no HEAD) — the harness measures a commit, so it needs one" };

  const { graph } = await loadGraph(root);
  const allTests = graph.files.filter(isRunnableTest);
  if (allTests.length === 0) {
    return { error: "no JS/TS test files in the graph — this harness executes JS suites only, so there is nothing here it can use as an oracle" };
  }

  // Candidates: source files that at least one test can reach. A file no test covers can only ever
  // produce an `undetected` trial, so spending a full suite run on it measures nothing.
  const covered = coveredSources(graph, allTests);
  const candidates = graph.files
    .filter((f) => !isTestFile(f) && covered.has(f))
    .filter((f) => (options.include ? options.include.some((p) => f.startsWith(p)) : true))
    .sort();
  if (candidates.length === 0) return { error: "no covered source files to mutate — every source file is unreachable from every test" };
  if (candidates.length < trialCount) {
    notes.push(`only ${candidates.length} covered source file(s) available; trials will revisit files with different faults`);
  }
  notes.push("measured against HEAD — uncommitted files are skipped, since there is no committed behaviour to break");

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "keel-evidence-"));
  const worktree = path.join(parent, "wt");
  const linkedModules = path.join(worktree, "node_modules");
  const cleanup = async (): Promise<void> => {
    unlinkDir(linkedModules);
    await git(root, ["worktree", "remove", "--force", worktree]);
    try {
      fs.rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* a temp dir we can't remove is not a result */
    }
    await git(root, ["worktree", "prune"]);
  };

  const trials: Trial[] = [];
  try {
    if ((await git(root, ["worktree", "add", "--detach", worktree, "HEAD"])) === null) {
      return { error: "could not create the git worktree the harness runs in" };
    }
    // One setup for the whole run: the reason this reuses a worktree instead of taking preflight's
    // one-per-run path, which would pay for node_modules on every trial.
    const mainModules = path.join(root, "node_modules");
    if (fs.existsSync(mainModules)) linkDir(mainModules, linkedModules);

    const next = sequence(seed);
    for (let i = 0; i < trialCount; i++) {
      const file = candidates[next() % candidates.length]!;
      trials.push(await runTrial(worktree, parent, file, next(), graph, allTests, timeoutMs));
      options.onTrial?.(trials[trials.length - 1]!, i + 1, trialCount);
    }
  } finally {
    await cleanup();
  }

  return { repo: root, head, seed, totalTests: allTests.length, trials, summary: summarize(trials, allTests.length), notes, durationMs: Date.now() - started };
}

async function runTrial(
  worktree: string,
  reportDir: string,
  file: string,
  siteIndex: number,
  graph: Awaited<ReturnType<typeof loadGraph>>["graph"],
  allTests: string[],
  timeoutMs: number,
): Promise<Trial> {
  const started = Date.now();
  const base: Omit<Trial, "outcome" | "durationMs"> = { file, selected: 0, failed: [], escapes: [] };
  const target = path.join(worktree, file);

  let original: string;
  try {
    original = fs.readFileSync(target, "utf8");
  } catch {
    // The worktree is at HEAD, so a file that exists only in the working tree isn't there. That is
    // correct — the harness measures a commit — but "ENOENT" would read like a harness fault.
    return { ...base, outcome: "skipped", reason: "not present at HEAD (uncommitted), so there is no committed behaviour to measure", durationMs: Date.now() - started };
  }

  const mutation = mutate(file, original, siteIndex);
  if (!mutation) {
    return { ...base, outcome: "skipped", reason: "no syntax-safe mutation site in this file", durationMs: Date.now() - started };
  }

  // keel's claim, made BEFORE the suite runs — exactly what preflight would select for a
  // content-only change to this file.
  const selection = selectTests(graph, [file]);
  const selected = selection.tests.map((t) => t.file);
  const selectedSet = new Set(selected);
  const detail = { line: mutation.line, from: mutation.from, to: mutation.to };

  try {
    fs.writeFileSync(target, mutation.mutated);
    const run = await runJsTests(worktree, path.join(reportDir, `report.${siteIndex}.json`), allTests, timeoutMs);

    if (run.timedOut || run.spawnError) {
      return { ...base, outcome: "skipped", mutation: detail, selected: selected.length, reason: run.spawnError ?? `the suite timed out after ${Math.round(timeoutMs / 1000)}s`, durationMs: Date.now() - started };
    }

    const failed = [...new Set((run.results?.failures ?? []).map((f) => f.file).filter((f): f is string => f !== undefined))];

    // A run that failed without naming a single test file tells us nothing about selection.
    if (run.status === "failed" && failed.length === 0) {
      return { ...base, outcome: "collapsed", mutation: detail, selected: selected.length, reason: "the suite failed without reporting per-test detail (the fault likely broke the build)", durationMs: Date.now() - started };
    }
    if (failed.length === 0) {
      return { ...base, outcome: "undetected", mutation: detail, selected: selected.length, reason: "the full suite did not notice this fault — the code it touches is uncovered", durationMs: Date.now() - started };
    }

    const escapes = failed.filter((f) => !selectedSet.has(f)).sort();
    return {
      ...base,
      outcome: escapes.length > 0 ? "escaped" : "caught",
      mutation: detail,
      selected: selected.length,
      failed: failed.sort(),
      escapes,
      durationMs: Date.now() - started,
    };
  } finally {
    fs.writeFileSync(target, original);
  }
}

/**
 * Is this a test file a RUNNER would actually execute?
 *
 * Deliberately stricter than `isTestFile`, which the graph uses and which also treats anything under
 * a `test/` directory as test-side code. That is right for selection — a fixture under `test/` is
 * not production code — but wrong for "the suite": keel's own `test/fixtures/**` holds ~120 Java, Go,
 * Python and TypeScript files that no runner ever runs. Counting them made the denominator 183
 * instead of ~65 and OVERSTATED selectivity by about twenty points, which is the exact direction a
 * measurement must never be wrong in. The suite is what the runner runs, so match on the naming
 * convention alone.
 */
export function isRunnableTest(relPosixPath: string): boolean {
  if (!isTestFile(relPosixPath)) return false;
  // JS/TS only, because `runJsTests` is the only suite this harness executes. Counting a repo's Go
  // or pytest files here would inflate the denominator with tests the run never touches — the same
  // flattering error as counting fixtures, one layer subtler. Wiring the other runners in would
  // widen both the numerator and this predicate together; until then the limitation is stated.
  return /\.(test|spec)\.(c|m)?[jt]sx?$/.test(relPosixPath.split("/").pop() ?? "");
}

/** Every source file reachable from some test — the only files worth spending a trial on. */
function coveredSources(graph: Awaited<ReturnType<typeof loadGraph>>["graph"], tests: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...tests];
  for (let i = 0; i < queue.length; i++) {
    for (const dep of graph.imports.get(queue[i]!) ?? []) {
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return seen;
}

function summarize(trials: Trial[], totalTests: number): SelectionEvidence["summary"] {
  const count = (outcome: TrialOutcome): number => trials.filter((t) => t.outcome === outcome).length;
  const caught = count("caught");
  const escaped = count("escaped");
  const measured = caught + escaped;
  const measuredTrials = trials.filter((t) => t.outcome === "caught" || t.outcome === "escaped");
  const meanSelected = measured > 0 ? measuredTrials.reduce((n, t) => n + t.selected, 0) / measured : null;

  return {
    measured,
    caught,
    escaped,
    undetected: count("undetected"),
    collapsed: count("collapsed"),
    skipped: count("skipped"),
    escapeRate: measured > 0 ? Number((escaped / measured).toFixed(3)) : null,
    selectivity: meanSelected !== null && totalTests > 0 ? Number((1 - meanSelected / totalTests).toFixed(3)) : null,
    meanSelected: meanSelected !== null ? Number(meanSelected.toFixed(1)) : null,
  };
}
