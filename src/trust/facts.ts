/**
 * Verdict facts: the machine-checkable inputs a policy is evaluated against, assembled by
 * composing the engines already built — impact, preflight, and the decision index. Pure
 * fact-gathering: NO model calls anywhere in the trust layer, not even local embeddings
 * (relevant decisions come from graph-node linkage, not semantic search).
 */
import { getImpact, type ChangedFile } from "../simulate/impact.js";
import { preflight } from "../simulate/preflight.js";
import { changedRoots } from "../simulate/select-tests.js";
import { loadGraph } from "../graph/cache.js";
import { resolveRepoRef } from "../github/remote.js";
import { decisionReceipt, type WhyDecision } from "../retrieval/why.js";
import { findForbiddenEdges, gatingViolations, type ArchViolation } from "./arch.js";
import { authorShares } from "../ownership/ownership.js";
import { detectFlakyTests, flakyMatcher } from "../ci/flaky.js";
import type { ForbiddenImport } from "./policy.js";
import type { KeelEvent } from "../events/store.js";
import type { SqliteEventStore } from "../events/sqlite-store.js";
import type { RunStatus } from "../simulate/sandbox.js";

export interface SimFacts {
  status: RunStatus;
  passed?: number;
  failed?: number;
  /** flaky: true means CI has seen this exact test both pass and fail on one commit (discounted) */
  failures: { test: string; file?: string; message: string; graphPath?: string[]; flaky?: boolean }[];
  /** set on apply-failed / timed-out / error — the reason the sim couldn't produce a verdict */
  error?: string;
  budget: { maxTests: number; maxSeconds: number; testsSkipped: string[]; truncated: boolean };
}

export interface VerdictFacts {
  /** files the diff touches (with status), for protected-path checks and receipts */
  changedFiles: ChangedFile[];
  /** file-level blast radius: count + the impacted files */
  blastRadius: number;
  impacted: string[];
  /** symbol-narrowed blast radius (a tighter subset) */
  narrowedRadius: number;
  /** executed test summary from preflight (null only if analysis failed) */
  sim: SimFacts;
  /** changed source files no selected test reaches */
  uncoveredChanges: string[];
  /** test files selected to cover the change */
  testsSelected: string[];
  /** decisions linked to any changed or impacted file — human-origin listed first & flagged.
   *  Honest v0: keel surfaces decisions the change *may* contradict; judging actual
   *  contradiction is the caller's job. */
  relevantDecisions: WhyDecision[];
  /** whether any relevant decision is human-origin (a stronger signal to review) */
  hasHumanDecision: boolean;
  /** forbidden import edges a changed file introduces or retains (empty if no rules configured) */
  forbiddenImports: ArchViolation[];
  /** changed files whose top author isn't the committer (only when warnOnForeignCode is on) */
  foreignChanges: { file: string; topAuthor: string; share: number }[];
}

/** Recent ci_run events scanned for the flaky signal — bounded so a busy repo stays fast. */
const FLAKY_RUN_WINDOW = 300;

export interface FactsOptions {
  diff?: string;
  maxTests?: number;
  maxSeconds?: number;
  /** architectural rules to check against the post-change graph (from the policy) */
  forbiddenImports?: ForbiddenImport[];
  /** compute foreign-code facts: flag changed files whose top author isn't `committer` */
  warnOnForeignCode?: boolean;
  /** the person making the change, for the foreign-code check (git user.name) */
  committer?: string;
  /** wall-clock for recency weighting (defaults to now); injected for deterministic tests */
  now?: number;
}

/** All the paths a changed-file entry touches (new + old side of a rename). */
export function touchedPaths(changed: ChangedFile[]): string[] {
  const paths = new Set<string>();
  for (const f of changed) {
    paths.add(f.path);
    if (f.oldPath) paths.add(f.oldPath);
  }
  return [...paths];
}

export async function assembleFacts(
  repoRoot: string,
  store: SqliteEventStore,
  options: FactsOptions = {},
): Promise<VerdictFacts | { error: string }> {
  const diffOpt = options.diff !== undefined ? { diff: options.diff } : {};

  // getImpact for changedFiles + the narrowed radius (preflight surfaces neither); it also
  // validates the diff, so a bad diff is caught here once.
  const impact = await getImpact(repoRoot, diffOpt);
  if ("error" in impact) return { error: impact.error };

  const pf = await preflight(repoRoot, {
    ...diffOpt,
    ...(options.maxTests !== undefined ? { maxTests: options.maxTests } : {}),
    ...(options.maxSeconds !== undefined ? { maxSeconds: options.maxSeconds } : {}),
  });
  if ("error" in pf) return { error: pf.error };

  const ref = await resolveRepoRef(repoRoot);
  const repoRef = "error" in ref ? null : ref;
  const relevant = await relevantDecisions(store, impact.changedFiles, pf.impacted, repoRef);

  // Discount failures CI has proven flaky (same test, same commit, both passed and failed). Only
  // when there's a failure to explain — otherwise there's nothing to look up.
  const failures: SimFacts["failures"] = pf.executed.failures;
  if (failures.length > 0) {
    const match = flakyMatcher(detectFlakyTests(await store.byKind("ci_run", FLAKY_RUN_WINDOW)));
    for (const f of failures) if (match.isFlaky(f.test, f.file)) f.flaky = true;
  }

  // Architectural rules read the post-change graph (the working tree) and gate on edges whose
  // importer the change touched — introduced or retained. Only loaded when rules are configured.
  let forbiddenImports: ArchViolation[] = [];
  if (options.forbiddenImports && options.forbiddenImports.length > 0) {
    const { graph } = await loadGraph(repoRoot);
    const all = findForbiddenEdges(graph, options.forbiddenImports);
    const changed = new Set(impact.changedFiles.map((f) => f.path));
    forbiddenImports = gatingViolations(all, changed);
  }

  // Foreign-code: a changed file whose recency-weighted top author isn't the committer. Only
  // when the policy asks and we know who's committing — otherwise there's nothing to compare.
  const foreignChanges: VerdictFacts["foreignChanges"] = [];
  if (options.warnOnForeignCode && options.committer) {
    const now = options.now ?? Date.now();
    for (const root of changedRoots(impact.changedFiles)) {
      const [top] = await authorShares(store, root, now);
      if (top && top.author !== options.committer) {
        foreignChanges.push({ file: root, topAuthor: top.author, share: Number(top.share.toFixed(3)) });
      }
    }
  }

  return {
    changedFiles: impact.changedFiles,
    blastRadius: pf.impacted.length,
    impacted: pf.impacted,
    narrowedRadius: impact.impactedNarrowed.length,
    sim: {
      status: pf.executed.status,
      ...(pf.executed.passed !== undefined ? { passed: pf.executed.passed } : {}),
      ...(pf.executed.failed !== undefined ? { failed: pf.executed.failed } : {}),
      failures,
      ...(pf.executed.error ? { error: pf.executed.error } : {}),
      budget: pf.budget,
    },
    uncoveredChanges: pf.uncoveredChanges,
    testsSelected: pf.testsSelected,
    ...relevant,
    forbiddenImports,
    foreignChanges,
  };
}

/** Decisions linked to any changed or impacted file, deduped, human-origin first. */
async function relevantDecisions(
  store: SqliteEventStore,
  changedFiles: ChangedFile[],
  impacted: string[],
  repoRef: Parameters<typeof decisionReceipt>[2],
): Promise<{ relevantDecisions: WhyDecision[]; hasHumanDecision: boolean }> {
  // changed roots (rename/delete resolve to the old path) marked "changed"; the impacted
  // blast radius marked "impacted". A changed link is the stronger signal.
  const targets = new Map<string, "changed" | "impacted">();
  for (const root of changedRoots(changedFiles)) targets.set(root, "changed");
  for (const file of impacted) if (!targets.has(file)) targets.set(file, "impacted");

  const suppressed = store.suppressedDecisions();
  const best = new Map<string, { decision: KeelEvent; label: string; kind: "changed" | "impacted" }>();
  for (const [file, kind] of targets) {
    for (const event of await store.byFile(file, 500)) {
      if (event.kind !== "decision" || event.externalId === undefined || suppressed.has(event.externalId)) continue;
      const existing = best.get(event.externalId);
      if (!existing || (kind === "changed" && existing.kind === "impacted")) {
        best.set(event.externalId, { decision: event, label: `${kind} (${file})`, kind });
      }
    }
  }

  const receipts = [...best.values()]
    .map((x) => decisionReceipt(x.decision, x.label, repoRef))
    .sort((a, b) => (a.origin === "human" ? 0 : 1) - (b.origin === "human" ? 0 : 1));
  return { relevantDecisions: receipts, hasHumanDecision: receipts.some((d) => d.origin === "human") };
}
