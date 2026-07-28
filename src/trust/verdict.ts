/**
 * The verdict: pure policy evaluation over the assembled facts, producing a machine-checkable
 * pass/warn/block a CI check or agent hook can gate on. Every reason names its rule and the
 * exact fact that triggered it — a verdict is auditable from its own output. No model calls.
 */
import { assembleFacts, touchedPaths, type FactsOptions, type SimFacts, type VerdictFacts } from "./facts.js";
import { DEFAULT_POLICY, globMatch, loadPolicy, type Policy } from "./policy.js";
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

function failureList(sim: SimFacts): string {
  return sim.failures
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
    // vitest/jest report per-test failures; node:test only reports a non-zero run.
    const detail =
      sim.failures.length > 0
        ? `${sim.failed ?? sim.failures.length} test(s) failed: ${failureList(sim)}`
        : "the test run failed (non-zero exit; the runner reported no per-test detail)";
    if (policy.requireSimPass) push("requireSimPass", "block", detail);
    else push("sim", "warn", `${detail} (requireSimPass is off)`);
  } else if (sim.status === "passed") {
    push(policy.requireSimPass ? "requireSimPass" : "sim", "pass", `all ${sim.passed ?? 0} selected test(s) passed`);
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

  const facts = await assembleFacts(repoRoot, store, options);
  if ("error" in facts) return { error: facts.error };

  const { verdict, reasons } = evaluatePolicy(facts, loaded.policy);
  return { verdict, reasons, facts, policy: { source: loaded.source, ...loaded.policy } };
}

export { DEFAULT_POLICY };
