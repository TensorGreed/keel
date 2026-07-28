/**
 * preflight: the flight simulator's single entry point. Wires the scoping engines together
 * — impact (diff -> impacted subgraph) -> select_tests (impacted -> covering tests) ->
 * sandbox (apply the diff in a worktree, run the tests) — and returns executed results
 * under hard budget caps.
 *
 * Budgets are ALWAYS reported, hit or not (docs/architecture.md: "Budgeted: hard caps ...
 * always reported"). When more tests are selected than maxTests allows, the ones nearest
 * the change (shortest import distance) run first and the rest are named as skipped. Every
 * failure carries the import chain from the failing test back to the nearest changed file.
 * A sandbox failure never throws across the protocol — it surfaces as executed.status.
 */
import { getImpact } from "./impact.js";
import { changedRoots, selectTests } from "./select-tests.js";
import { runSandbox, type Runner, type RunStatus, type TestFailure } from "./sandbox.js";
import { loadHeadGraph } from "../graph/cache.js";

const DEFAULT_MAX_TESTS = 50;
const DEFAULT_MAX_SECONDS = 120;

export interface PreflightOptions {
  diff?: string;
  maxTests?: number;
  maxSeconds?: number;
}

export interface PreflightFailure {
  test: string;
  file?: string;
  /** the failure's first line */
  message: string;
  /** the full error/stack the runner reported (capped) */
  trace?: string;
  /** import chain from the failing test file back to the nearest changed file */
  graphPath?: string[];
  /** "collection-error" when a test file couldn't be imported/collected (not an assertion) */
  kind?: "collection-error";
}

export interface PreflightResult {
  /** file-level blast radius of the change */
  impacted: string[];
  /** every test that covers the change (before the cap) */
  testsSelected: string[];
  /** changed source files no selected test reaches */
  uncoveredChanges: string[];
  executed: {
    status: RunStatus;
    /** which runner executed (vitest | jest | node | pytest), or null if nothing ran */
    runner: Runner | null;
    passed?: number;
    failed?: number;
    failures: PreflightFailure[];
    durationMs: number;
    error?: string;
    output?: string;
  };
  budget: {
    maxTests: number;
    maxSeconds: number;
    /** selected tests not run because of maxTests (prioritized out) */
    testsSkipped: string[];
    truncated: boolean;
  };
}

function envPositiveInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export async function preflight(
  repoRoot: string,
  options: PreflightOptions = {},
): Promise<PreflightResult | { error: string }> {
  const maxTests = options.maxTests ?? envPositiveInt("KEEL_MAX_TESTS") ?? DEFAULT_MAX_TESTS;
  const maxSeconds = options.maxSeconds ?? envPositiveInt("KEEL_MAX_SECONDS") ?? DEFAULT_MAX_SECONDS;
  const diffOpt = options.diff !== undefined ? { diff: options.diff } : {};

  const impact = await getImpact(repoRoot, diffOpt);
  if ("error" in impact) return { error: impact.error };

  const { graph } = await loadHeadGraph(repoRoot);
  const selection = selectTests(graph, changedRoots(impact.changedFiles));

  // Prioritize by shortest import distance to a changed file so, under the cap, the tests
  // most likely to catch the regression run first.
  const ordered = selection.tests
    .map((t) => t.file)
    .sort((a, b) => (pathLen(selection.paths[a]) - pathLen(selection.paths[b])) || a.localeCompare(b));
  const cap = Math.max(0, maxTests);
  const toRun = ordered.slice(0, cap);
  const testsSkipped = ordered.slice(cap).sort();

  // The sandbox picks the runner from the selected tests (pytest for Python, vitest/jest/node
  // otherwise). A change's covering tests are one language — there are no cross-language edges —
  // so the selection is homogeneous.
  const sandbox = await runSandbox(repoRoot, {
    ...diffOpt,
    testFiles: toRun,
    timeoutMs: maxSeconds * 1000,
    maxTests: toRun.length, // already capped here; don't let the sandbox re-cap
  });

  const failures: PreflightFailure[] = (sandbox.failures ?? []).map((f: TestFailure) => {
    const graphPath = f.file ? selection.paths[f.file] : undefined;
    return {
      test: f.name,
      ...(f.file ? { file: f.file } : {}),
      message: f.message,
      ...(f.trace ? { trace: f.trace } : {}),
      ...(graphPath ? { graphPath } : {}),
      ...(f.kind ? { kind: f.kind } : {}),
    };
  });

  return {
    impacted: impact.impactedFiles,
    testsSelected: ordered,
    uncoveredChanges: selection.uncoveredChanges,
    executed: {
      status: sandbox.status,
      runner: sandbox.runner,
      ...(sandbox.passed !== undefined ? { passed: sandbox.passed } : {}),
      ...(sandbox.failed !== undefined ? { failed: sandbox.failed } : {}),
      failures,
      durationMs: sandbox.durationMs,
      ...(sandbox.error ? { error: sandbox.error } : {}),
      ...(sandbox.output ? { output: sandbox.output } : {}),
    },
    budget: {
      maxTests,
      maxSeconds,
      testsSkipped,
      truncated: testsSkipped.length > 0,
    },
  };
}

function pathLen(chain: string[] | undefined): number {
  return chain ? chain.length : Number.MAX_SAFE_INTEGER;
}
