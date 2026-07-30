/**
 * `keel upgrade` Phase 1: the agent-driven repair loop.
 *
 * ## Why the loop is inverted
 *
 * The body of a repair loop is "write the code that fixes this failure", and principle 1 forbids
 * keel from doing that server-side. So keel does not run the loop — it *is* the loop's other half.
 * Each call takes the caller's accumulated patch, proves what it does, and hands back either GREEN
 * or exactly one next task with everything needed to write the next patch. The agent iterates.
 *
 * ## Why it's stateless
 *
 * No sessions, no server-side working copy, no cleanup to leak. A step is a pure function of
 * (repo, target, patch): the agent already holds the patch — it wrote it — so asking it to send that
 * back costs nothing and removes an entire class of lifecycle bug. It also means two agents can
 * explore two different repair paths for the same upgrade concurrently without interfering, and a
 * crashed agent loses nothing but its own patch.
 *
 * ## One failure at a time, and which one
 *
 * Handing over ten failures invites ten simultaneous guesses. Tasks are therefore ordered by what a
 * fix has to happen *before*: install-time breaks first (a peer conflict means the tests never ran
 * against the tree you think they did), then failures whose import site is known (actionable), then
 * the rest. `remaining` says how many are behind it, so the agent can see the shape of the job
 * without being handed it all at once.
 *
 * ## Budget
 *
 * Keel can't stop an agent from looping forever, but it can refuse to feed it: past `maxAttempts`
 * the status is `exhausted` and no further task is issued. The attempt counter is passed in like
 * everything else — see stateless, above.
 */
import { getImpact } from "../simulate/impact.js";
import { changedRoots, selectTests } from "../simulate/select-tests.js";
import { loadHeadGraph } from "../graph/cache.js";
import type { SqliteEventStore } from "../events/sqlite-store.js";
import { executeBump, symbolsInPlay, type UpgradeFailure } from "./execute.js";
import type { PackageEvidence } from "./evidence.js";
import type { InstallSignal } from "./install.js";
import { parseTarget } from "./upgrade.js";
import { scopeUpgrade, type UpgradeScope } from "./scope.js";
import { EMPTY_MEMORY, recallUpgradeMemory, recordRepair, type PastRepair, type UpgradeMemory } from "./memory.js";
import type { WhyDecision } from "../retrieval/why.js";
import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_MAX_TESTS = 50;
const DEFAULT_MAX_SECONDS = 300;
const DEFAULT_MAX_ATTEMPTS = 10;
/** Lines of the import site to quote in a task — enough to see the call, not the whole file. */
const MAX_SOURCE_LINES = 120;

export const AGENT_WRITES_THE_FIX =
  "Keel does not write fixes. It scoped this upgrade, executed it, and judged the result; the patch " +
  "is yours to write. Send it back as `patch` (a unified diff against HEAD) and keel will re-run.";

export type RepairStatus =
  /** install clean, every selected test passing — the patch (if any) is a complete repair */
  | "green"
  /** at least one break remains, and a task is attached */
  | "work"
  /** attempts are spent and it is still not green — stop and escalate */
  | "exhausted"
  /** the step could not be evaluated at all (the patch doesn't apply, the runner is missing) */
  | "blocked";

export interface RepairTask {
  /** what kind of edit this needs: source code, or the manifest (a peer/engine problem) */
  kind: "source" | "manifest";
  /** one-line statement of what is broken */
  title: string;
  /** the failing test, when this task came from an executed failure */
  failure?: UpgradeFailure;
  /** the install signal, when this task came from the install rather than a test */
  installSignal?: InstallSignal;
  /** the file to edit first */
  targetFile?: string;
  /** the import site's source, so the agent can see the call it must change */
  source?: { file: string; text: string; truncated: boolean };
  /** the package's exports this file actually uses */
  symbolsInPlay?: string[];
  /** the package's own account of the change: changelog span + a diff of its manifest and entry */
  evidence?: PackageEvidence;
  /** recorded decisions that may bear on this upgrade — read the receipts BEFORE writing a fix */
  pins?: WhyDecision[];
  /** how this package was repaired before; the migration may already be worked out */
  pastRepairs?: PastRepair[];
  /** how many other breaks are queued behind this one */
  remaining: number;
}

export interface RepairStep {
  status: RepairStatus;
  package: string;
  requested: string;
  installedVersion: string | null;
  attempt: number;
  maxAttempts: number;
  scope: UpgradeScope;
  /** tests actually run this step — the upgrade's covering tests plus any the patch touches */
  testsRun: string[];
  install: { ran: boolean; ok: boolean; signals: InstallSignal[]; error?: string };
  executed: {
    status: string;
    passed?: number;
    failed?: number;
    failures: UpgradeFailure[];
    discountedFlaky: UpgradeFailure[];
    durationMs: number;
    error?: string;
    output?: string;
  };
  /** the single next thing to fix — absent when green, exhausted, or blocked */
  task?: RepairTask;
  /** every outstanding break, one line each, so the agent can see the whole job */
  outstanding: string[];
  /** what the team already recorded about this dependency */
  memory: UpgradeMemory;
  /** set when a green repair was written back to the event log, for the next upgrade of this package */
  recorded?: string;
  /** stated every step: keel executed and judged; the caller writes the code */
  contract: string;
  /** why the step is blocked, when it is */
  blocked?: string;
}

export interface RepairOptions {
  /** the accumulated repair so far: a unified diff against HEAD */
  patch?: string;
  attempt?: number;
  maxAttempts?: number;
  maxTests?: number;
  maxSeconds?: number;
  store?: SqliteEventStore;
}

export async function runRepairStep(
  repoRoot: string,
  target: string,
  options: RepairOptions = {},
): Promise<RepairStep | { error: string }> {
  const parsed = parseTarget(target);
  if ("error" in parsed) return parsed;
  const { package: pkg, spec } = parsed;

  const attempt = options.attempt ?? 1;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxTests = options.maxTests ?? DEFAULT_MAX_TESTS;
  const maxSeconds = options.maxSeconds ?? DEFAULT_MAX_SECONDS;
  const patch = options.patch?.trim() ? options.patch : undefined;

  const { graph } = await loadHeadGraph(repoRoot);
  const scope = scopeUpgrade(graph, pkg, repoRoot);

  // Memory first, and attached to every task: an agent about to "fix" an upgrade the team already
  // rejected needs to see that BEFORE it writes a line, not after the patch is proven.
  const memory = options.store
    ? await recallUpgradeMemory(repoRoot, options.store, pkg, scope.importSites, graph)
    : EMPTY_MEMORY;

  // The tests to run are the upgrade's covering tests PLUS the tests covering whatever the patch
  // touched. A repair that edits a file outside the upgrade surface must still be proven — otherwise
  // "green" would only mean "green for the code we were already looking at".
  let roots = [...scope.importSites];
  if (patch) {
    const impact = await getImpact(repoRoot, { diff: patch });
    if ("error" in impact) {
        return blockedStep(pkg, spec, scope, memory, attempt, maxAttempts, `the patch does not apply to HEAD: ${impact.error}`);
    }
    roots = [...new Set([...roots, ...changedRoots(impact.changedFiles)])];
  }

  const selection = selectTests(graph, roots);
  const ordered = selection.tests
    .map((t) => t.file)
    .sort((a, b) => (chainLength(selection.paths[a]) - chainLength(selection.paths[b])) || a.localeCompare(b));
  const testsRun = ordered.slice(0, Math.max(0, maxTests));

  const run = await executeBump(repoRoot, {
    pkg,
    spec,
    ...(patch ? { patch } : {}),
    testFiles: testsRun,
    timeoutMs: maxSeconds * 1000,
    paths: { ...scope.paths, ...selection.paths },
    importSites: scope.importSites,
    ...(options.store ? { store: options.store } : {}),
    withEvidence: true,
  });

  const install = {
    ran: run.bump !== null,
    ok: run.bump !== null && !run.bump.error && (run.bump.exitCode === null || run.bump.exitCode === 0),
    signals: run.bump?.signals ?? [],
    ...(run.bump?.error ? { error: run.bump.error } : {}),
  };
  const executed = {
    status: run.sandbox.status,
    ...(run.sandbox.passed !== undefined ? { passed: run.sandbox.passed } : {}),
    ...(run.sandbox.failed !== undefined ? { failed: run.sandbox.failed } : {}),
    failures: run.failures,
    discountedFlaky: run.discountedFlaky,
    durationMs: run.sandbox.durationMs,
    ...(run.sandbox.error ? { error: run.sandbox.error } : {}),
    ...(run.sandbox.output ? { output: run.sandbox.output } : {}),
  };

  const base: Omit<RepairStep, "status" | "outstanding"> = {
    memory,
    package: pkg,
    requested: spec,
    installedVersion: run.bump?.installedVersion ?? null,
    attempt,
    maxAttempts,
    scope,
    testsRun,
    install,
    executed,
    contract: AGENT_WRITES_THE_FIX,
  };

  // A run that couldn't execute is blocked, not failed: there is no evidence to repair against, and
  // handing the agent a task would invite a fix for a problem that was never demonstrated.
  const UNRUNNABLE = new Set(["apply-failed", "timed-out", "runner-unavailable", "runner-unsupported", "environment-error"]);
  if (UNRUNNABLE.has(run.sandbox.status) || (run.sandbox.status === "error" && install.ok)) {
    return {
      ...base,
      status: "blocked",
      outstanding: [],
      blocked: run.sandbox.error ?? `the sim could not run (${run.sandbox.status})`,
    };
  }

  const tasks = buildTasks(repoRoot, pkg, scope, install.signals, run.failures, run.evidence, memory);
  const outstanding = tasks.map((t) => `[${t.kind}] ${t.title}`);

  if (tasks.length === 0) {
    // Green. If the install itself never completed we are NOT green, whatever the tests did.
    if (!install.ok) {
      return { ...base, status: "blocked", outstanding: [], blocked: install.error ?? "npm install did not complete" };
    }
    // A green repair is memory for the next upgrade of this package: record what made it work, so
    // the second team to hit this breaking change doesn't rediscover the migration from scratch.
    // Only an actual repair is worth recording — a bump that was already clean taught nobody anything.
    let recorded: string | undefined;
    if (options.store && patch) {
      try {
        recorded = await recordRepair(options.store, {
          package: pkg,
          // The version that WAS installed, not the manifest's specifier: `file:/long/path` or
          // `^1.0.0` tells a future reader nothing about what this patch migrated from.
          from: run.evidence?.fromVersion ?? run.bump?.from ?? null,
          to: run.bump?.installedVersion ?? spec,
          patch,
          provenTests: testsRun,
          importSites: scope.importSites,
          attempts: attempt,
        });
      } catch {
        recorded = undefined; // recording is a bonus; never let it cost the caller its green result
      }
    }
    return { ...base, status: "green", outstanding: [], ...(recorded ? { recorded } : {}) };
  }

  if (attempt >= maxAttempts) {
    return { ...base, status: "exhausted", outstanding };
  }

  return { ...base, status: "work", task: tasks[0]!, outstanding };
}

/**
 * The queue of outstanding breaks, most-blocking first. An install signal outranks every test
 * failure: if the dependency tree isn't the one the package asked for, the test results below it
 * were produced against something other than the upgrade under discussion.
 */
function buildTasks(
  repoRoot: string,
  pkg: string,
  scope: UpgradeScope,
  signals: InstallSignal[],
  failures: UpgradeFailure[],
  evidence: PackageEvidence | null,
  memory: UpgradeMemory,
): RepairTask[] {
  const tasks: RepairTask[] = [];

  for (const signal of signals) {
    tasks.push({
      kind: "manifest",
      title: signal.message,
      installSignal: signal,
      targetFile: "package.json",
      ...(evidence ? { evidence } : {}),
      ...(memory.pins.length > 0 ? { pins: memory.pins } : {}),
      ...(memory.pastRepairs.length > 0 ? { pastRepairs: memory.pastRepairs } : {}),
      remaining: 0, // filled in below, once the queue is known
    });
  }

  // Actionable first: a failure keel can point at an import site is one the agent can start on.
  const ordered = [...failures].sort((a, b) => {
    const known = Number(Boolean(b.importSite)) - Number(Boolean(a.importSite));
    if (known !== 0) return known;
    return (a.file ?? a.test).localeCompare(b.file ?? b.test);
  });

  for (const failure of ordered) {
    const site = failure.importSite ?? (scope.importSites.length === 1 ? scope.importSites[0] : undefined);
    tasks.push({
      kind: "source",
      title: `${failure.test} — ${failure.message}`,
      failure,
      ...(site ? { targetFile: site } : {}),
      ...(site ? { source: readSource(repoRoot, site) } : {}),
      ...(site ? { symbolsInPlay: symbolsInPlay(repoRoot, site, pkg) } : {}),
      ...(evidence ? { evidence } : {}),
      ...(memory.pins.length > 0 ? { pins: memory.pins } : {}),
      ...(memory.pastRepairs.length > 0 ? { pastRepairs: memory.pastRepairs } : {}),
      remaining: 0,
    });
  }

  for (let i = 0; i < tasks.length; i++) tasks[i]!.remaining = tasks.length - i - 1;
  return tasks;
}

/** The import site's source, capped — the agent needs to see the call, not read the whole module. */
function readSource(repoRoot: string, relFile: string): { file: string; text: string; truncated: boolean } | undefined {
  try {
    const lines = fs.readFileSync(path.join(repoRoot, relFile), "utf8").split("\n");
    const truncated = lines.length > MAX_SOURCE_LINES;
    const text = lines.slice(0, MAX_SOURCE_LINES).join("\n") + (truncated ? `\n… (${lines.length - MAX_SOURCE_LINES} more lines)` : "");
    return { file: relFile, text, truncated };
  } catch {
    return undefined;
  }
}

function blockedStep(
  pkg: string,
  spec: string,
  scope: UpgradeScope,
  memory: UpgradeMemory,
  attempt: number,
  maxAttempts: number,
  reason: string,
): RepairStep {
  return {
    status: "blocked",
    package: pkg,
    requested: spec,
    installedVersion: null,
    attempt,
    maxAttempts,
    scope,
    testsRun: [],
    install: { ran: false, ok: false, signals: [] },
    executed: { status: "error", failures: [], discountedFlaky: [], durationMs: 0 },
    outstanding: [],
    memory,
    contract: AGENT_WRITES_THE_FIX,
    blocked: reason,
  };
}

function chainLength(chain: string[] | undefined): number {
  return chain ? chain.length : Number.MAX_SAFE_INTEGER;
}
