/**
 * `keel upgrade` Phase 3: many packages in one pass, classified by policy.
 *
 * ## Ordering
 *
 * Every target is SCOPED first — graph-only, no install, milliseconds — and ranked by risk before
 * any of them is executed. Risk here is a composite of the four things that actually decide how
 * much an upgrade can hurt: how much of the repo it reaches, how much of that reach no test proves,
 * how far the version moves (a major is a different kind of event from a patch), and whether the
 * team recorded a decision about it.
 *
 * The batch then runs in ASCENDING risk order, safest first. That is deliberate and it is about the
 * budget: a batch that runs out of time should have finished the upgrades most likely to be
 * mergeable, not have spent everything on the one that was never going to land. The ranking is
 * reported either way, so the dangerous ones are visible without having to be executed first.
 *
 * ## Budget
 *
 * One wall-clock budget for the whole pass, consumed as it goes. When it runs out the remaining
 * packages come back as `not-run` — named, in rank order, with the reason. Silently truncating a
 * batch would be the single most misleading thing this command could do: "no problems found" and
 * "we stopped looking" have to be distinguishable.
 *
 * ## Policy
 *
 * `keel.policy.json`'s `upgrades` block decides what each result MEANS. A pinned package is not
 * executed at all — running an install for something policy forbids spends budget to learn nothing
 * — and comes back with the recorded reason. Everything else is classified from its executed
 * verdict: `auto-merge` only if the policy opted in AND the run was green AND the package isn't in
 * `alwaysReview`; otherwise `needs-review`, `blocked`, or `failed`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadPolicy, type Policy, type PinnedPackage } from "../trust/policy.js";
import { findDeclaration } from "./install.js";
import type { SqliteEventStore } from "../events/sqlite-store.js";
import { parseTarget, runUpgradeAnalysis, type UpgradeReport } from "./upgrade.js";
import { scopeUpgrade, type UpgradeScope } from "./scope.js";
import { loadHeadGraph } from "../graph/cache.js";
import { recallUpgradeMemory, EMPTY_MEMORY, type UpgradeMemory } from "./memory.js";
import { buildPrProposal, type PrProposal } from "./pr.js";

const DEFAULT_BATCH_SECONDS = 1_800; // 30 min for a whole pass; each package still has its own cap
const DEFAULT_PER_PACKAGE_SECONDS = 300;

export type BatchOutcome =
  /** policy says don't move this one; not executed */
  | "pinned"
  /** green, and the policy allows merging it without a human */
  | "auto-merge"
  /** it worked, but a human has to look — policy, a pin decision, or a warn verdict */
  | "needs-review"
  /** the bump breaks something: failing tests, or an install that won't complete */
  | "blocked"
  /** the batch budget ran out before this one was reached */
  | "not-run";

export interface BatchEntry {
  package: string;
  requested: string;
  outcome: BatchOutcome;
  /** why this outcome, in one line */
  reason: string;
  /** 0–1, higher is riskier; the order the batch ran in */
  risk: number;
  /** the components behind the score, so a ranking can be argued with */
  riskFactors: { shareOfRepo: number; uncoveredShare: number; versionJump: "major" | "minor" | "patch" | "unknown"; pinnedByDecision: boolean };
  /** the executed report — absent for pinned and not-run entries, which never ran */
  report?: UpgradeReport;
  /** everything needed to open a PR for this one, when there is something to propose */
  pr?: PrProposal;
}

export interface BatchResult {
  entries: BatchEntry[];
  /** counts by outcome, for a one-line summary */
  summary: Record<BatchOutcome, number>;
  budget: { maxSeconds: number; usedSeconds: number; exhausted: boolean };
  policySource: "default" | "file";
  notes: string[];
}

export interface BatchOptions {
  maxSeconds?: number;
  maxTestsPerPackage?: number;
  maxSecondsPerPackage?: number;
  store?: SqliteEventStore;
  /** wall clock, injected for deterministic tests */
  now?: () => number;
}

/** Glob match for package names: `*` matches any run of characters (including `/`). */
export function packageMatches(pattern: string, pkg: string): boolean {
  if (pattern === pkg) return true;
  if (!pattern.includes("*")) return false;
  const re = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
  return re.test(pkg);
}

/** The policy pin covering this package, if any. */
export function pinFor(policy: Policy, pkg: string): PinnedPackage | null {
  return policy.upgrades.pinned.find((p) => packageMatches(p.package, pkg)) ?? null;
}

/**
 * How far the version moves. Only meaningful when both sides are plain semver — a `file:` path or a
 * dist-tag is "unknown", which the risk score treats as major-ish rather than pretending it's safe.
 */
export function versionJump(from: string | null, to: string): "major" | "minor" | "patch" | "unknown" {
  const parse = (v: string | null): [number, number, number] | null => {
    const m = /^[^\d]*(\d+)\.(\d+)\.(\d+)/.exec(v ?? "");
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const a = parse(from);
  const b = parse(to);
  if (!a || !b) return "unknown";
  if (a[0] !== b[0]) return "major";
  if (a[1] !== b[1]) return "minor";
  return "patch";
}

const JUMP_WEIGHT: Record<ReturnType<typeof versionJump>, number> = { major: 1, unknown: 0.8, minor: 0.4, patch: 0.1 };

/**
 * Risk, 0–1. Deliberately a small readable formula rather than a tuned model: the components are
 * reported alongside the score so a reader can disagree with the weighting instead of having to
 * trust it. Reach and unproven-reach dominate; the version jump and a recorded decision lift it.
 */
export function riskScore(factors: BatchEntry["riskFactors"]): number {
  const score =
    0.4 * factors.shareOfRepo +
    0.3 * factors.uncoveredShare +
    0.2 * JUMP_WEIGHT[factors.versionJump] +
    0.1 * (factors.pinnedByDecision ? 1 : 0);
  return Number(Math.min(1, score).toFixed(3));
}

interface Planned {
  package: string;
  spec: string;
  scope: UpgradeScope;
  memory: UpgradeMemory;
  risk: number;
  riskFactors: BatchEntry["riskFactors"];
  pin: PinnedPackage | null;
}

export async function runUpgradeBatch(
  repoRoot: string,
  targets: string[],
  options: BatchOptions = {},
): Promise<BatchResult | { error: string }> {
  if (targets.length === 0) return { error: "no packages given — usage: keel upgrade --batch <pkg>@<version> …" };

  const loaded = loadPolicy(repoRoot);
  if ("error" in loaded) return { error: `keel.policy.json is invalid: ${loaded.error}` };
  const policy = loaded.policy;

  const maxSeconds = options.maxSeconds ?? DEFAULT_BATCH_SECONDS;
  const perPackageSeconds = options.maxSecondsPerPackage ?? DEFAULT_PER_PACKAGE_SECONDS;
  const now = options.now ?? (() => Date.now());
  const notes: string[] = [];

  // --- plan: scope everything cheaply, then rank ---------------------------
  const { graph } = await loadHeadGraph(repoRoot);
  const planned: Planned[] = [];
  for (const target of targets) {
    const parsed = parseTarget(target);
    if ("error" in parsed) {
      notes.push(`skipped "${target}": ${parsed.error}`);
      continue;
    }
    const scope = scopeUpgrade(graph, parsed.package, repoRoot);
    const memory = options.store
      ? await recallUpgradeMemory(repoRoot, options.store, parsed.package, scope.importSites, graph)
      : EMPTY_MEMORY;
    const declared = declaredVersion(repoRoot, parsed.package);
    const riskFactors = {
      shareOfRepo: scope.shareOfRepo,
      uncoveredShare: scope.surface.length > 0 ? Number((scope.uncoveredSurface.length / scope.surface.length).toFixed(3)) : 0,
      versionJump: versionJump(declared, parsed.spec),
      pinnedByDecision: memory.pins.length > 0,
    };
    planned.push({
      package: parsed.package,
      spec: parsed.spec,
      scope,
      memory,
      riskFactors,
      risk: riskScore(riskFactors),
      pin: pinFor(policy, parsed.package),
    });
  }

  // Safest first: a truncated batch should have landed the upgrades most likely to be mergeable.
  planned.sort((a, b) => a.risk - b.risk || a.package.localeCompare(b.package));

  // --- execute in rank order, against one shared budget --------------------
  const started = now();
  const deadline = started + maxSeconds * 1000;
  const entries: BatchEntry[] = [];

  for (const item of planned) {
    const base = { package: item.package, requested: item.spec, risk: item.risk, riskFactors: item.riskFactors };

    if (item.pin) {
      entries.push({ ...base, outcome: "pinned", reason: `keel.policy.json pins this package: ${item.pin.reason}` });
      continue;
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      entries.push({ ...base, outcome: "not-run", reason: `the batch budget of ${maxSeconds}s ran out before this package was reached` });
      continue;
    }

    const report = await runUpgradeAnalysis(repoRoot, `${item.package}@${item.spec}`, {
      maxSeconds: Math.max(1, Math.min(perPackageSeconds, Math.floor(remainingMs / 1000))),
      ...(options.maxTestsPerPackage !== undefined ? { maxTests: options.maxTestsPerPackage } : {}),
      ...(options.store ? { store: options.store } : {}),
    });
    if ("error" in report) {
      entries.push({ ...base, outcome: "blocked", reason: report.error });
      continue;
    }

    const { outcome, reason } = classify(report, policy);
    entries.push({
      ...base,
      outcome,
      reason,
      report,
      // A pinned or unrunnable package has nothing to propose; everything else does, even when it
      // needs review — the proof is what makes the review short.
      pr: buildPrProposal(repoRoot, report, outcome),
    });
  }

  const usedSeconds = Math.round((now() - started) / 1000);
  const summary: Record<BatchOutcome, number> = { pinned: 0, "auto-merge": 0, "needs-review": 0, blocked: 0, "not-run": 0 };
  for (const entry of entries) summary[entry.outcome]++;
  if (summary["not-run"] > 0) {
    notes.push(`${summary["not-run"]} package(s) were NOT analysed — the batch budget ran out. This is not a clean result for them.`);
  }
  if (loaded.source === "default") {
    notes.push("no keel.policy.json — nothing can auto-merge, and every green upgrade is classified needs-review");
  }

  return {
    entries,
    summary,
    budget: { maxSeconds, usedSeconds, exhausted: summary["not-run"] > 0 },
    policySource: loaded.source,
    notes,
  };
}

/**
 * What an executed report means under the policy. `auto-merge` requires three independent things to
 * line up — the policy opted in, the package isn't reserved for review, and the run was actually
 * green — because it is the one outcome that removes a human from the loop.
 */
export function classify(report: UpgradeReport, policy: Policy): { outcome: BatchOutcome; reason: string } {
  // An install that never completed is not a result. This outranks the verdict, because the policy
  // rules are about a change that was executed and this one wasn't.
  if (!report.install.ran) {
    return { outcome: "needs-review", reason: "nothing was installed or executed, so nothing about this bump has been proven" };
  }
  if (!report.install.ok) {
    return { outcome: "blocked", reason: report.install.error ?? `npm install did not complete (exit ${report.install.exitCode ?? "?"})` };
  }

  const green = report.verdict.verdict === "pass";
  if (!green) {
    const failures = report.executed.failures.length;
    const install = report.install.signals.length;
    const detail =
      failures > 0 ? `${failures} test(s) fail under the bump`
      : install > 0 ? `the install reported ${install} problem(s)`
      : report.verdict.reasons.map((r) => r.detail).join("; ") || "the verdict was not a pass";
    return { outcome: report.verdict.verdict === "block" ? "blocked" : "needs-review", reason: detail };
  }

  const reserved = policy.upgrades.alwaysReview.find((pattern) => packageMatches(pattern, report.package));
  if (reserved) {
    return { outcome: "needs-review", reason: `green, but keel.policy.json reserves "${reserved}" for human review` };
  }
  if (report.memory.pins.length > 0) {
    return {
      outcome: "needs-review",
      reason: `green, but ${report.memory.pins.length} recorded decision(s) mention this dependency — read them before merging`,
    };
  }
  if (!policy.upgrades.autoMergeOnGreen) {
    return { outcome: "needs-review", reason: "green; keel.policy.json does not enable autoMergeOnGreen" };
  }
  // "No test failed" and "no test ran" are the same verdict and completely different facts. A bump
  // nothing covers has been installed and nothing more; it must never merge itself.
  if (report.executed.status === "no-tests") {
    return {
      outcome: "needs-review",
      reason: "the install is clean, but NO test covers this dependency — nothing about the code was proven",
    };
  }
  if (report.scope.uncoveredSurface.length > 0) {
    return {
      outcome: "needs-review",
      reason: `green, but ${report.scope.uncoveredSurface.length} file(s) in the upgrade surface are reached by no test — the green run does not cover them`,
    };
  }
  return { outcome: "auto-merge", reason: "green, fully covered, and allowed by policy" };
}

/** What package.json declares for `pkg` today — the "from" side of the version jump. */
function declaredVersion(repoRoot: string, pkg: string): string | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as unknown;
    return findDeclaration(manifest, pkg)?.spec ?? null;
  } catch {
    return null;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
