/**
 * One sandboxed execution of a bump — shared by the Phase 0 report and the Phase 1 repair loop, so
 * the two can never disagree about what "we ran it" means.
 *
 * The sequence inside the worktree is: apply the caller's patch (a repair attempt; empty for a bare
 * bump), then rewrite package.json to the target version and install, then run the selected tests.
 * That order matters. The patch goes first because a repair may edit package.json itself — bumping a
 * conflicting peer, say — and keel's own rewrite is a read-modify-write of one dependency entry, so
 * it preserves whatever the patch did to the rest of the manifest.
 *
 * Package evidence is collected here too, because it can only be collected here: the new version
 * exists solely inside the sandbox, and the worktree is destroyed on the way out.
 */
import { runSandbox, type SandboxResult } from "../simulate/sandbox.js";
import { detectFlakyTests, flakyMatcher } from "../ci/flaky.js";
import type { SqliteEventStore } from "../events/sqlite-store.js";
import { bumpAndInstall, type BumpResult } from "./install.js";
import { buildPackageEvidence, readPackageSnapshot, symbolsInPlay, type PackageEvidence } from "./evidence.js";

/** Recent ci_run events scanned for the flaky signal — the bound the trust layer uses. */
const FLAKY_RUN_WINDOW = 300;
/** Evidence gathering is a nicety; it must never eat the run's budget. */
const EVIDENCE_BUDGET_MS = 10_000;

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

export interface ExecuteRequest {
  pkg: string;
  spec: string;
  /** a unified diff applied before the bump — the accumulated repair, or omitted for a bare bump */
  patch?: string;
  testFiles: string[];
  timeoutMs: number;
  /** test file -> shortest import chain back to an import site, for attributing failures */
  paths: Record<string, string[]>;
  importSites: string[];
  store?: SqliteEventStore;
  /** gather the package's changelog + own diff (repair tasks need it; a bare report doesn't) */
  withEvidence?: boolean;
}

export interface ExecuteResult {
  bump: BumpResult | null;
  sandbox: SandboxResult;
  /** failures with graph paths and import sites, flaky ones removed */
  failures: UpgradeFailure[];
  /** failures CI has proven flaky — separated, never dropped */
  discountedFlaky: UpgradeFailure[];
  evidence: PackageEvidence | null;
}

export async function executeBump(repoRoot: string, request: ExecuteRequest): Promise<ExecuteResult> {
  // The version installed in the repo today — readable now, and gone from comparison range once the
  // sandbox has its own tree.
  const previous = request.withEvidence ? readPackageSnapshot(repoRoot, request.pkg) : null;
  const symbols = request.withEvidence
    ? [...new Set(request.importSites.flatMap((site) => symbolsInPlay(repoRoot, site, request.pkg)))].sort()
    : [];

  // Holders rather than bare locals: these are assigned inside the prepare callback, which
  // TypeScript's control flow can't see through.
  const captured: { bump: BumpResult | null; evidence: PackageEvidence | null } = { bump: null, evidence: null };

  const sandbox = await runSandbox(repoRoot, {
    diff: request.patch ?? "",
    testFiles: request.testFiles,
    timeoutMs: request.timeoutMs,
    maxTests: request.testFiles.length, // capped by the caller; don't let the sandbox re-cap
    linkNodeModules: false, // this run needs its OWN dependency tree — see install.ts
    prepare: async (worktree, budgetMs) => {
      const result = await bumpAndInstall(worktree, request.pkg, request.spec, budgetMs);
      captured.bump = result;

      // An install that never completed is terminal — there is nothing to test. A completed install
      // carrying peer/engine warnings is NOT: those are reported, and the tests still run.
      if (result.error) return { error: result.error, status: "error" as const, output: result.output };
      if (result.exitCode !== null && result.exitCode !== 0) {
        return { error: `npm install failed (exit ${result.exitCode})`, status: "error" as const, output: result.output };
      }

      if (request.withEvidence) {
        // Bounded and best-effort: the new version only exists here, but failing to describe it must
        // never cost the run its result.
        try {
          captured.evidence = await buildPackageEvidence(
            previous,
            readPackageSnapshot(worktree, request.pkg),
            symbols,
            Math.min(EVIDENCE_BUDGET_MS, budgetMs),
          );
        } catch {
          captured.evidence = null;
        }
      }
      return { output: result.output };
    },
  });

  const siteSet = new Set(request.importSites);
  const all: UpgradeFailure[] = (sandbox.failures ?? []).map((f) => {
    const graphPath = f.file ? request.paths[f.file] : undefined;
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

  // Flaky discounting, applied AND labelled. A discounted failure survives into its own list — the
  // point is that a reader can see what was discounted and disagree.
  if (request.store && all.length > 0) {
    const match = flakyMatcher(detectFlakyTests(await request.store.byKind("ci_run", FLAKY_RUN_WINDOW)));
    for (const f of all) if (match.isFlaky(f.test, f.file)) f.flaky = true;
  }

  return {
    bump: captured.bump,
    sandbox,
    failures: all.filter((f) => !f.flaky),
    discountedFlaky: all.filter((f) => f.flaky),
    evidence: captured.evidence,
  };
}

/** The symbols the repo's import sites pull from the package — exported for the repair task. */
export { symbolsInPlay };
