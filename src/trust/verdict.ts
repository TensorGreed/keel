/**
 * The verdict: pure policy evaluation over the assembled facts, producing a machine-checkable
 * pass/warn/block a CI check or agent hook can gate on. Every reason names its rule and the
 * exact fact that triggered it — a verdict is auditable from its own output. No model calls.
 */
import { assembleFacts, touchedPaths, type FactsOptions, type SimFacts, type VerdictFacts } from "./facts.js";
import { DEFAULT_POLICY, globMatch, loadPolicy, type Policy } from "./policy.js";
import { describeViolation } from "./arch.js";
import { resolveCommitter } from "../ownership/ownership.js";
import type { SqliteEventStore } from "../events/sqlite-store.js";

export type VerdictLevel = "pass" | "warn" | "block";

export interface VerdictReason {
  rule: string;
  outcome: VerdictLevel;
  detail: string;
}

export interface Verdict {
  verdict: VerdictLevel;
  reasons: VerdictReason[];
  facts: VerdictFacts;
  policy: Policy & { source: "default" | "file" };
}

const HARD_ERROR_STATUS: Record<string, true> = { "apply-failed": true, "timed-out": true, error: true };

function failureList(failures: SimFacts["failures"]): string {
  return failures
    .slice(0, 5)
    .map((f) => (f.file ? `${f.test} (${f.file})` : f.test))
    .join(", ");
}

/** Pure evaluation of a policy against facts → verdict level + audited reasons. */
export function evaluatePolicy(facts: VerdictFacts, policy: Policy): { verdict: VerdictLevel; reasons: VerdictReason[] } {
  const reasons: VerdictReason[] = [];
  const push = (rule: string, outcome: VerdictLevel, detail: string): void => {
    reasons.push({ rule, outcome, detail });
  };

  // --- sim status ---
  const sim = facts.sim;
  if (HARD_ERROR_STATUS[sim.status]) {
    // The sim couldn't produce a result — can't affirm safety, so block.
    push("sim", "block", `the sim could not run (${sim.status})${sim.error ? `: ${sim.error}` : ""}`);
  } else if (sim.status === "failed") {
    // CI-proven flaky failures (same test both passed and failed on one commit) are discounted:
    // they aren't evidence of a regression, so a run whose only failures are flaky doesn't block.
    const real = sim.failures.filter((f) => !f.flaky);
    const flaky = sim.failures.filter((f) => f.flaky);
    if (sim.failures.length > 0 && real.length === 0) {
      push("sim", "warn", `${flaky.length} test(s) failed, but all are known-flaky in CI (passed and failed on the same commit) — discounted; re-run to confirm`);
    } else {
      // vitest/jest report per-test failures; node:test only reports a non-zero run.
      const base =
        real.length > 0
          ? `${real.length} test(s) failed: ${failureList(real)}`
          : "the test run failed (non-zero exit; the runner reported no per-test detail)";
      const flakyNote = flaky.length > 0 ? ` (${flaky.length} known-flaky failure(s) discounted)` : "";
      if (policy.requireSimPass) push("requireSimPass", "block", base + flakyNote);
      else push("sim", "warn", `${base}${flakyNote} (requireSimPass is off)`);
    }
  } else if (sim.status === "passed") {
    push(policy.requireSimPass ? "requireSimPass" : "sim", "pass", `all ${sim.passed ?? 0} selected test(s) passed`);
  } else if (sim.status === "runner-unsupported") {
    // We selected the tests but can't execute them yet (e.g. Python). Don't pretend it passed;
    // don't hard-block either — warn that this change is unverified by the sim.
    push("sim", "warn", `the change's tests couldn't be executed${sim.error ? ` (${sim.error})` : ""} — verify manually`);
  } else if (sim.status === "no-tests" && facts.changedFiles.some((f) => f.inGraph)) {
    // The diff applied but nothing exercises it — a real (soft) blind spot.
    push("coverage", "warn", "the change applied cleanly but no tests cover it");
  }

  // --- protected paths ---
  if (policy.protectedPaths.length > 0) {
    const touched = touchedPaths(facts.changedFiles);
    let anyHit = false;
    for (const protectedPath of policy.protectedPaths) {
      const hits = touched.filter((p) => globMatch(protectedPath.glob, p));
      if (hits.length > 0) {
        anyHit = true;
        push("protectedPaths", "block", `${hits.join(", ")} matches protected "${protectedPath.glob}" (${protectedPath.reason})`);
      }
    }
    if (!anyHit) push("protectedPaths", "pass", "no protected paths touched");
  }

  // --- architectural import rules ---
  if (policy.forbiddenImports.length > 0) {
    if (facts.forbiddenImports.length > 0) {
      for (const v of facts.forbiddenImports) push("forbiddenImports", "block", describeViolation(v));
    } else {
      push("forbiddenImports", "pass", "no forbidden import edges introduced or retained by the change");
    }
  }

  // --- blast radius cap ---
  if (policy.maxBlastRadius !== null) {
    if (facts.blastRadius > policy.maxBlastRadius) {
      push("maxBlastRadius", "block", `blast radius ${facts.blastRadius} exceeds max ${policy.maxBlastRadius}`);
    } else {
      push("maxBlastRadius", "pass", `blast radius ${facts.blastRadius} within max ${policy.maxBlastRadius}`);
    }
  }

  // --- uncovered changes ---
  if (policy.forbidUncoveredChanges) {
    if (facts.uncoveredChanges.length > 0) {
      push("forbidUncoveredChanges", "block", `${facts.uncoveredChanges.length} changed file(s) have no covering test: ${facts.uncoveredChanges.join(", ")}`);
    } else {
      push("forbidUncoveredChanges", "pass", "every changed file has a covering test");
    }
  }

  // --- truncated sim ---
  const truncated = sim.budget.truncated;
  if (policy.forbidTruncatedSim) {
    if (truncated) {
      push("forbidTruncatedSim", "block", `the sim skipped ${sim.budget.testsSkipped.length} selected test(s) at the cap of ${sim.budget.maxTests}`);
    } else {
      push("forbidTruncatedSim", "pass", "the sim ran every selected test");
    }
  } else if (truncated) {
    push("sim", "warn", `the sim skipped ${sim.budget.testsSkipped.length} selected test(s) at the cap of ${sim.budget.maxTests}`);
  }

  // --- decision review ---
  if (policy.requireDecisionReview) {
    if (facts.relevantDecisions.length > 0) {
      const human = facts.relevantDecisions.filter((d) => d.origin === "human").length;
      const humanNote = human > 0 ? ` (${human} human-recorded — review these first)` : "";
      push("requireDecisionReview", "warn", `${facts.relevantDecisions.length} recorded decision(s) may be affected${humanNote}`);
    } else {
      push("requireDecisionReview", "pass", "no recorded decisions link to the change");
    }
  }

  // --- foreign code (soft signal) ---
  if (policy.warnOnForeignCode) {
    if (facts.foreignChanges.length > 0) {
      const list = facts.foreignChanges.slice(0, 5).map((f) => `${f.file} (mostly ${f.topAuthor})`).join(", ");
      push("warnOnForeignCode", "warn", `${facts.foreignChanges.length} changed file(s) are mostly authored by someone else — consider their review: ${list}`);
    } else {
      push("warnOnForeignCode", "pass", "the change stays within the committer's own code (or authorship is unknown)");
    }
  }

  const verdict: VerdictLevel = reasons.some((r) => r.outcome === "block")
    ? "block"
    : reasons.some((r) => r.outcome === "warn")
      ? "warn"
      : "pass";
  return { verdict, reasons };
}

/** Load the policy, assemble facts, evaluate. Errors returned as data — never thrown. */
export async function computeVerdict(
  repoRoot: string,
  store: SqliteEventStore,
  options: FactsOptions = {},
): Promise<Verdict | { error: string }> {
  // Load (and validate) the policy first — a malformed policy fails cheaply, before the sim.
  const loaded = loadPolicy(repoRoot);
  if ("error" in loaded) return { error: loaded.error };

  // Hand the arch rules to fact-gathering so it computes the gating violations (needs the graph),
  // and the committer when the policy wants the foreign-code check.
  const committer = loaded.policy.warnOnForeignCode ? await resolveCommitter(repoRoot) : null;
  const facts = await assembleFacts(repoRoot, store, {
    ...options,
    ...(loaded.policy.forbiddenImports.length > 0 ? { forbiddenImports: loaded.policy.forbiddenImports } : {}),
    ...(loaded.policy.warnOnForeignCode ? { warnOnForeignCode: true } : {}),
    ...(committer ? { committer } : {}),
  });
  if ("error" in facts) return { error: facts.error };

  const { verdict, reasons } = evaluatePolicy(facts, loaded.policy);
  return { verdict, reasons, facts, policy: { source: loaded.source, ...loaded.policy } };
}

export { DEFAULT_POLICY };
