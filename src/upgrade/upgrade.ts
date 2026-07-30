/**
 * `keel upgrade` Phase 0: scope an upgrade, discover what it breaks, report. **No repairs.**
 *
 * The three steps are the three pillars pointed at one question. SCOPE is the graph: who imports
 * this package, what depends on them, which tests cover it (scope.ts). DISCOVERY is the flight
 * simulator: apply only the version bump in a throwaway worktree, install, run exactly those tests,
 * and read the install log for the breaks that happen before any test does (install.ts). REPORT is
 * the trust layer's honesty rules: every failure carries a graph path back to the import site that
 * probably caused it, a failure CI has proven flaky is discounted **and said to be discounted**,
 * the part of the surface no test covers is named, and the budget is reported whether or not it bit.
 *
 * Two things this deliberately does NOT do. It doesn't try to fix anything — that's Phase 1, and the
 * report says so in as many words, because a report that merely omits repairs reads like one that
 * found nothing to repair. And it doesn't decide for you: the verdict at the end is the existing
 * policy evaluator run over these facts, so an upgrade is judged by the same rules as any change.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadHeadGraph } from "../graph/cache.js";
import { detectFlakyTests, flakyMatcher } from "../ci/flaky.js";
import { runSandbox, type Runner, type RunStatus } from "../simulate/sandbox.js";
import { evaluatePolicy, type VerdictLevel, type VerdictReason } from "../trust/verdict.js";
import { loadPolicy } from "../trust/policy.js";
import type { SqliteEventStore } from "../events/sqlite-store.js";
import { bumpAndInstall, findDeclaration, type BumpResult, type InstallSignal } from "./install.js";
import { scopeUpgrade, type UpgradeScope } from "./scope.js";

const DEFAULT_MAX_TESTS = 50;
/** Generous next to preflight's 120s: this run pays for an `npm install` before a test can start. */
const DEFAULT_MAX_SECONDS = 300;
/** Recent ci_run events scanned for the flaky signal — same bound the trust layer uses. */
const FLAKY_RUN_WINDOW = 300;

export const REPORT_ONLY_NOTICE =
  "REPORT ONLY — keel attempted no repairs. Every failure below is a work item, not a fix. " +
  "The worktree used for this run has been destroyed; your checkout is untouched.";

export interface UpgradeFailure {
  test: string;
  file?: string;
  message: string;
  trace?: string;
  /** import chain from the failing test back to the import site that likely caused it */
  graphPath?: string[];
  /** the import site the graph path lands on — the call site to look at first */
  importSite?: string;
  kind?: "collection-error";
  /** true when CI has seen this exact test pass AND fail on one commit; discounted, never hidden */
  flaky?: boolean;
}

export interface UpgradeReport {
  package: string;
  /** the requested specifier: a version, a dist-tag like `latest`, or any npm range */
  requested: string;
  /** what package.json declared before, and where */
  from: string | null;
  section: string | null;
  /** the version npm actually installed */
  installedVersion: string | null;
  scope: UpgradeScope;
  install: {
    ok: boolean;
    exitCode: number | null;
    signals: InstallSignal[];
    error?: string;
  };
  executed: {
    status: RunStatus;
    runner: Runner | null;
    passed?: number;
    failed?: number;
    /** real failures — flaky ones are separated out, not silently dropped */
    failures: UpgradeFailure[];
    /** failures discounted as known-flaky, listed so the discount is auditable */
    discountedFlaky: UpgradeFailure[];
    durationMs: number;
    error?: string;
    output?: string;
  };
  /** every break as a work item, install signals first (they precede any test) */
  nextSteps: string[];
  /** stated in the output, every time — this phase repairs nothing */
  reportOnly: string;
  /** true when nothing was installed or executed: the graph answer alone */
  scopeOnly: boolean;
  verdict: { verdict: VerdictLevel; reasons: VerdictReason[] };
  budget: { maxTests: number; maxSeconds: number; testsSkipped: string[]; truncated: boolean };
}

export interface UpgradeOptions {
  maxTests?: number;
  maxSeconds?: number;
  /** skip the sandbox entirely and report scope only — cheap, and no install runs */
  scopeOnly?: boolean;
  /** event store for the flaky signal; omit to skip discounting (nothing is hidden either way) */
  store?: SqliteEventStore;
}

/** Split `<pkg>@<spec>` — the last `@` that isn't the scope marker. `latest` when no spec is given. */
export function parseTarget(target: string): { package: string; spec: string } | { error: string } {
  const trimmed = target.trim();
  if (trimmed === "") return { error: "no package given — usage: keel upgrade <pkg>@<version|latest>" };
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return { package: trimmed, spec: "latest" }; // bare name, or a scope-only leading @
  return { package: trimmed.slice(0, at), spec: trimmed.slice(at + 1) || "latest" };
}

function envPositiveInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export async function runUpgradeAnalysis(
  repoRoot: string,
  target: string,
  options: UpgradeOptions = {},
): Promise<UpgradeReport | { error: string }> {
  const parsed = parseTarget(target);
  if ("error" in parsed) return parsed;
  const { package: pkg, spec } = parsed;

  const maxTests = options.maxTests ?? envPositiveInt("KEEL_MAX_TESTS") ?? DEFAULT_MAX_TESTS;
  const maxSeconds = options.maxSeconds ?? envPositiveInt("KEEL_MAX_SECONDS") ?? DEFAULT_MAX_SECONDS;

  // --- 1. SCOPE (graph) ----------------------------------------------------
  const { graph } = await loadHeadGraph(repoRoot);
  const scope = scopeUpgrade(graph, pkg);

  // Order by shortest chain to an import site, so under the cap the tests nearest the dependency run
  // first — the same prioritization preflight uses.
  const ordered = [...scope.testsSelected].sort(
    (a, b) => (chainLength(scope.paths[a]) - chainLength(scope.paths[b])) || a.localeCompare(b),
  );
  const toRun = ordered.slice(0, Math.max(0, maxTests));
  const testsSkipped = ordered.slice(Math.max(0, maxTests)).sort();
  const budget = { maxTests, maxSeconds, testsSkipped, truncated: testsSkipped.length > 0 };

  if (options.scopeOnly) {
    // Still read what package.json declares today. It costs nothing, and reporting "not declared"
    // for a package that plainly IS declared would be a lie by omission.
    const declared = declaredIn(repoRoot, pkg);
    return assemble(repoRoot, pkg, spec, scope, budget, {
      from: declared?.spec ?? null,
      section: declared?.section ?? null,
      installedVersion: null,
      install: { ok: true, exitCode: null, signals: [] },
      executed: { status: "no-tests", runner: null, failures: [], discountedFlaky: [], durationMs: 0 },
      scopeOnly: true,
    });
  }

  // --- 2. BREAK DISCOVERY (preflight) --------------------------------------
  // `diff: ""` means a clean checkout of HEAD with nothing applied — the bump is the ONLY change,
  // made by the prepare hook. node_modules is not shared: this run needs its own dependency tree.
  // A holder rather than a bare `let`: the assignment happens inside the prepare callback, which
  // TypeScript's control flow can't see, so a plain local would narrow to `never` after the call.
  const captured: { bump: BumpResult | null } = { bump: null };
  const sandbox = await runSandbox(repoRoot, {
    diff: "",
    testFiles: toRun,
    timeoutMs: maxSeconds * 1000,
    maxTests: toRun.length, // already capped above; don't let the sandbox re-cap
    linkNodeModules: false,
    prepare: async (worktree, budgetMs) => {
      const result = await bumpAndInstall(worktree, pkg, spec, budgetMs);
      captured.bump = result;
      // An install that never completed is terminal — there is nothing to test. A completed install
      // with peer/engine warnings is NOT: those are reported, and the tests still run.
      if (result.error) return { error: result.error, status: "error" as const, output: result.output };
      if (result.exitCode !== null && result.exitCode !== 0) {
        return { error: `npm install failed (exit ${result.exitCode})`, status: "error" as const, output: result.output };
      }
      return { output: result.output };
    },
  });

  const installed = captured.bump;
  const siteSet = new Set(scope.importSites);
  const allFailures: UpgradeFailure[] = (sandbox.failures ?? []).map((f) => {
    const graphPath = f.file ? scope.paths[f.file] : undefined;
    const importSite = graphPath?.find((step) => siteSet.has(step));
    return {
      test: f.name,
      ...(f.file ? { file: f.file } : {}),
      message: f.message,
      ...(f.trace ? { trace: f.trace } : {}),
      ...(graphPath ? { graphPath } : {}),
      ...(importSite ? { importSite } : {}),
      ...(f.kind ? { kind: f.kind } : {}),
    };
  });

  // Flaky discounting, applied AND labelled. A discounted failure stays in the report under its own
  // heading — the point is that the reader can see what was discounted and disagree.
  if (options.store && allFailures.length > 0) {
    const match = flakyMatcher(detectFlakyTests(await options.store.byKind("ci_run", FLAKY_RUN_WINDOW)));
    for (const f of allFailures) if (match.isFlaky(f.test, f.file)) f.flaky = true;
  }
  const failures = allFailures.filter((f) => !f.flaky);
  const discountedFlaky = allFailures.filter((f) => f.flaky);

  return assemble(repoRoot, pkg, spec, scope, budget, {
    from: installed?.from ?? null,
    section: installed?.section ?? null,
    installedVersion: installed?.installedVersion ?? null,
    install: {
      ok: !installed?.error && (installed?.exitCode === null || installed?.exitCode === 0),
      exitCode: installed?.exitCode ?? null,
      signals: installed?.signals ?? [],
      ...(installed?.error ? { error: installed.error } : {}),
    },
    executed: {
      status: sandbox.status,
      runner: sandbox.runner,
      ...(sandbox.passed !== undefined ? { passed: sandbox.passed } : {}),
      ...(sandbox.failed !== undefined ? { failed: sandbox.failed } : {}),
      failures,
      discountedFlaky,
      durationMs: sandbox.durationMs,
      ...(sandbox.error ? { error: sandbox.error } : {}),
      ...(sandbox.output ? { output: sandbox.output } : {}),
    },
    scopeOnly: false,
  });
}

interface AssembleParts {
  from: string | null;
  section: string | null;
  installedVersion: string | null;
  install: UpgradeReport["install"];
  executed: UpgradeReport["executed"];
  scopeOnly: boolean;
}

/** Compose the report, derive the work items, and judge the bare bump with the existing policy. */
function assemble(
  repoRoot: string,
  pkg: string,
  spec: string,
  scope: UpgradeScope,
  budget: UpgradeReport["budget"],
  parts: AssembleParts,
): UpgradeReport {
  const nextSteps: string[] = [];
  // Install signals first: they happen before any test, and they can invalidate the test run itself.
  for (const signal of parts.install.signals) nextSteps.push(`[install/${signal.kind}] ${signal.message}`);
  for (const f of parts.executed.failures) {
    const where = f.importSite ? ` — via import site ${f.importSite}` : f.file ? ` — in ${f.file}` : "";
    nextSteps.push(`[test] ${f.test}${where}: ${f.message}`);
  }
  if (scope.uncoveredSurface.length > 0) {
    nextSteps.push(
      `[coverage] ${scope.uncoveredSurface.length} file(s) in the upgrade surface are reached by no test — ` +
        `a green run does not clear them (e.g. ${scope.uncoveredSurface.slice(0, 3).join(", ")})`,
    );
  }
  if (budget.truncated) {
    nextSteps.push(`[budget] ${budget.testsSkipped.length} covering test(s) were not run (maxTests=${budget.maxTests})`);
  }
  if (parts.scopeOnly) {
    nextSteps.push("[scope-only] no install and no tests were run — re-run without scopeOnly for executed proof");
  }

  return {
    package: pkg,
    requested: spec,
    from: parts.from,
    section: parts.section,
    installedVersion: parts.installedVersion,
    scope,
    install: parts.install,
    executed: parts.executed,
    nextSteps,
    reportOnly: REPORT_ONLY_NOTICE,
    scopeOnly: parts.scopeOnly,
    verdict: judge(repoRoot, scope, parts),
    budget,
  };
}

/**
 * The verdict for the bare bump. Reuses the policy evaluator so an upgrade is judged by the same
 * rules as any other change — but the facts are assembled here rather than by the trust layer's
 * `assembleFacts`, which starts from a git diff. A version bump plus a different node_modules tree
 * isn't a diff, so the honest move is to fill the fields we genuinely know and leave the rest empty
 * rather than invent them.
 *
 * An install signal is added as a synthetic failure so it can never be judged as a pass: a peer
 * conflict is a break the tests were never in a position to catch.
 */
function judge(repoRoot: string, scope: UpgradeScope, parts: AssembleParts): { verdict: VerdictLevel; reasons: VerdictReason[] } {
  const loaded = loadPolicy(repoRoot);
  const policy = "error" in loaded ? undefined : loaded.policy;
  if (!policy) {
    return { verdict: "block", reasons: [{ rule: "policy", outcome: "block", detail: `keel.policy.json is invalid: ${(loaded as { error: string }).error}` }] };
  }

  const simFailures = [
    ...parts.install.signals.map((s) => ({ test: `install: ${s.kind}`, message: s.message })),
    ...parts.executed.failures.map((f) => ({
      test: f.test,
      ...(f.file ? { file: f.file } : {}),
      message: f.message,
      ...(f.graphPath ? { graphPath: f.graphPath } : {}),
    })),
    // Flaky ones are handed over flagged, so the evaluator applies its own discount rule to them —
    // the same one it uses for a preflight, rather than a second rule invented here.
    ...parts.executed.discountedFlaky.map((f) => ({
      test: f.test,
      ...(f.file ? { file: f.file } : {}),
      message: f.message,
      flaky: true,
    })),
  ];
  const status: RunStatus = simFailures.length > 0 ? "failed" : parts.executed.status;

  return evaluatePolicy(
    {
      changedFiles: [{ path: "package.json", status: "modified", inGraph: false }],
      blastRadius: scope.surface.length,
      impacted: scope.surface,
      narrowedRadius: scope.importSites.length,
      sim: {
        status,
        ...(parts.executed.passed !== undefined ? { passed: parts.executed.passed } : {}),
        failed: simFailures.length,
        failures: simFailures,
        ...(parts.executed.error ? { error: parts.executed.error } : {}),
        budget: { maxTests: 0, maxSeconds: 0, testsSkipped: [], truncated: false },
      },
      uncoveredChanges: scope.uncoveredSurface,
      testsSelected: scope.testsSelected,
      relevantDecisions: [], // Phase 2 wires the decision index in ("why is this pinned?")
      hasHumanDecision: false,
      forbiddenImports: [],
      foreignChanges: [],
    },
    policy,
  );
}

/** What the repo's package.json declares for `pkg` right now (null if it doesn't, or can't be read). */
function declaredIn(repoRoot: string, pkg: string): { section: string; spec: string } | null {
  try {
    return findDeclaration(JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")), pkg);
  } catch {
    return null;
  }
}

function chainLength(chain: string[] | undefined): number {
  return chain ? chain.length : Number.MAX_SAFE_INTEGER;
}
