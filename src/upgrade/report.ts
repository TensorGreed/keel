/**
 * Rendering an UpgradeReport for a terminal. Pure string formatting over the structured result — the
 * `--json` output is the same object, so nothing is computed here that a machine reader can't see.
 *
 * Section order mirrors how the answer is actually built: surface first (is this even a big
 * upgrade?), then what broke, then what was discounted and why, then what the run couldn't speak to,
 * then the work items and the verdict. The report-only line is printed twice on purpose — once up
 * top where a skimmer lands, once at the end next to the work items where it would otherwise read
 * like a to-do list keel was about to start on.
 */
import type { UpgradeFailure, UpgradeReport } from "./upgrade.js";
import type { RepairStep, RepairTask } from "./repair.js";
import type { UpgradeMemory } from "./memory.js";
import type { BatchResult } from "./batch.js";

const BULLET = "  •";

export function renderUpgradeReport(report: UpgradeReport): string {
  const out: string[] = [];
  const version = report.installedVersion ? ` → ${report.installedVersion}` : "";
  out.push(`keel upgrade — ${report.package}@${report.requested}${version}`);
  out.push(`  ${report.reportOnly}`);
  out.push("");

  // --- surface ---
  const s = report.scope;
  out.push("Upgrade surface");
  const declared = report.from ? `${report.from} (${report.section ?? "dependencies"})` : "not declared in package.json";
  out.push(`  currently:      ${declared}`);
  out.push(`  import sites:   ${s.importSites.length}${s.specifiers.length > 0 ? ` (${s.specifiers.join(", ")})` : ""}`);
  for (const site of s.importSites.slice(0, 10)) out.push(`${BULLET} ${site}`);
  if (s.importSites.length > 10) out.push(`     … ${s.importSites.length - 10} more`);
  out.push(`  blast radius:   ${s.surface.length} file(s), ${(s.shareOfRepo * 100).toFixed(1)}% of the repo`);
  out.push(`  covering tests: ${s.testsSelected.length}`);
  out.push(
    `  uncovered:      ${s.uncoveredSurface.length} file(s) in the surface reached by no test` +
      (s.uncoveredSurface.length > 0 ? " — a green run does NOT clear these" : ""),
  );
  for (const note of s.notes) out.push(`  note: ${note}`);
  out.push("");
  out.push(...renderMemory(report.memory));

  // A scope-only run installed nothing and executed nothing. Saying so is the whole difference
  // between "this bump is clean" and "we didn't look" — printing a green install section here would
  // be the most misleading thing this report could do.
  if (report.scopeOnly) {
    out.push("Install / executed tests");
    out.push("  NOT RUN — --scope-only reports the graph surface only. Nothing was installed, no");
    out.push("  test was executed, and NOTHING below has been proven. Re-run without --scope-only.");
    out.push("");
    out.push(`Verdict: withheld (scope-only) — the surface above is all this run can support`);
    return out.join("\n");
  }

  // --- install ---
  out.push("Install");
  out.push(
    `  status: ${
      !report.install.ran
        ? "NOT RUN — no covering tests and nothing to install against"
        : report.install.ok
          ? "completed"
          : `FAILED${report.install.exitCode !== null ? ` (exit ${report.install.exitCode})` : ""}`
    }`,
  );
  if (report.install.error) out.push(`  error:  ${report.install.error}`);
  if (report.install.signals.length === 0) {
    out.push("  no peer-dependency or engine problems reported");
  } else {
    for (const signal of report.install.signals) {
      out.push(`${BULLET} BREAK (${signal.kind}): ${signal.message}`);
      for (const line of signal.evidence.slice(0, 4)) out.push(`      ${line}`);
    }
  }
  out.push("");

  // --- executed ---
  const e = report.executed;
  out.push("Executed tests");
  const counts = [e.passed !== undefined ? `${e.passed} passed` : null, e.failed !== undefined ? `${e.failed} failed` : null]
    .filter(Boolean)
    .join(", ");
  out.push(`  ${e.status}${e.runner ? ` via ${e.runner}` : ""}${counts ? ` — ${counts}` : ""} in ${(e.durationMs / 1000).toFixed(1)}s`);
  if (e.error) out.push(`  error: ${e.error}`);
  for (const f of e.failures) out.push(...renderFailure(f));
  if (e.failures.length === 0 && e.status !== "failed") out.push("  no failures");

  if (e.discountedFlaky.length > 0) {
    out.push("");
    out.push(`Discounted (${e.discountedFlaky.length}) — still shown, so you can disagree`);
    for (const f of e.discountedFlaky) {
      out.push(`${BULLET} ${f.test}${f.file ? ` (${f.file})` : ""} — discounted: flaky per CI history`);
      out.push(`      ${f.message}`);
    }
  }
  out.push("");

  // --- budget ---
  out.push("Budget");
  out.push(`  maxTests ${report.budget.maxTests}, maxSeconds ${report.budget.maxSeconds}${report.budget.truncated ? "" : " — not hit"}`);
  if (report.budget.truncated) {
    out.push(`  ${report.budget.testsSkipped.length} covering test(s) NOT run: ${report.budget.testsSkipped.slice(0, 5).join(", ")}`);
  }
  out.push("");

  // --- next steps ---
  out.push(`Next steps (${report.nextSteps.length}) — work items for you or your agent; keel fixed nothing`);
  if (report.nextSteps.length === 0) out.push("  none — the bare bump is clean as far as this run can see");
  for (const step of report.nextSteps) out.push(`${BULLET} ${step}`);
  out.push("");

  // --- verdict ---
  out.push(`Verdict for the bare bump: ${report.verdict.verdict.toUpperCase()}`);
  for (const reason of report.verdict.reasons) out.push(`${BULLET} [${reason.rule}] ${reason.outcome}: ${reason.detail}`);

  return out.join("\n");
}

/**
 * What the team already recorded. Placed BEFORE any executed result on purpose: a pin questions
 * whether the upgrade should happen at all, and no test outcome answers that.
 */
function renderMemory(memory: UpgradeMemory): string[] {
  if (memory.pins.length === 0 && memory.pastRepairs.length === 0 && memory.notes.length === 0) return [];
  const out: string[] = ["Team memory"];

  if (memory.pins.length === 0) {
    out.push("  no recorded decision mentions this dependency");
  } else {
    out.push(`  ${memory.pins.length} recorded decision(s) may bear on this upgrade — keel does not judge whether they forbid it:`);
    for (const pin of memory.pins.slice(0, 5)) {
      out.push(`${BULLET} [${pin.origin}] ${pin.summary}`);
      if (pin.rationale) out.push(`      ${pin.rationale}`);
      out.push(`      receipt: ${pin.source.url ?? pin.source.adrPath ?? (pin.source.pr !== null ? `PR #${pin.source.pr}` : pin.id)}`);
    }
    if (memory.pins.length > 5) out.push(`     … ${memory.pins.length - 5} more`);
  }

  if (memory.pastRepairs.length > 0) {
    out.push(`  ${memory.pastRepairs.length} previous repair(s) of this package are on record:`);
    for (const repair of memory.pastRepairs) {
      out.push(`${BULLET} ${repair.from ?? "?"} → ${repair.to} on ${repair.occurredAt.slice(0, 10)}${repair.attempts ? ` (${repair.attempts} attempt(s))` : ""}`);
      out.push(`      touched: ${repair.importSites.slice(0, 4).join(", ") || "—"}`);
      out.push(indent(truncateLines(repair.patch, 20), 6));
    }
  }
  for (const note of memory.notes) out.push(`  note: ${note}`);
  out.push("");
  return out;
}

function truncateLines(text: string, max: number): string {
  const lines = text.split("\n");
  return lines.length <= max ? text : `${lines.slice(0, max).join("\n")}\n… (${lines.length - max} more lines)`;
}

function renderFailure(f: UpgradeFailure): string[] {
  const lines = [`${BULLET} FAIL ${f.test}${f.file ? ` (${f.file})` : ""}`];
  lines.push(`      ${f.message}`);
  if (f.importSite) lines.push(`      import site: ${f.importSite}`);
  if (f.graphPath && f.graphPath.length > 1) lines.push(`      graph path:  ${f.graphPath.join(" → ")}`);
  if (f.kind === "collection-error") lines.push("      (the test file could not even be loaded)");
  return lines;
}

/**
 * Rendering a repair step. Where the Phase 0 report answers "what breaks?", this answers "what do I
 * do next?" — so it leads with the status and the single task, and puts the evidence the agent needs
 * to write the patch (the call site, the symbols it uses, the package's own account of the change)
 * inline rather than behind another call.
 */
export function renderRepairStep(step: RepairStep): string {
  const out: string[] = [];
  out.push(`keel upgrade --repair — ${step.package}@${step.requested}${step.installedVersion ? ` → ${step.installedVersion}` : ""}`);
  out.push(`  attempt ${step.attempt}/${step.maxAttempts} · ${step.testsRun.length} test(s) run · status: ${step.status.toUpperCase()}`);
  out.push(`  ${step.contract}`);
  for (const note of step.scope.notes) out.push(`  note: ${note}`);
  out.push("");
  out.push(...renderMemory(step.memory));

  if (step.status === "blocked") {
    out.push("BLOCKED — nothing was proven, so there is nothing to repair against.");
    out.push(`  ${step.blocked ?? "the step could not be evaluated"}`);
    if (step.executed.output) out.push(`  output tail:\n${indent(step.executed.output, 4)}`);
    return out.join("\n");
  }

  if (step.status === "green") {
    out.push("GREEN — the bump installs cleanly and every selected test passes.");
    out.push(`  ${step.executed.passed ?? 0} passed across ${step.testsRun.length} test file(s) in ${(step.executed.durationMs / 1000).toFixed(1)}s`);
    if (step.recorded) {
      out.push(`  Recorded as team memory (${step.recorded}) — the next upgrade of this package starts from this patch.`);
    }
    if (step.scope.uncoveredSurface.length > 0) {
      out.push(
        `  Still unproven: ${step.scope.uncoveredSurface.length} file(s) in the upgrade surface are ` +
          `reached by no test (${step.scope.uncoveredSurface.slice(0, 3).join(", ")}).`,
      );
    }
    if (step.executed.discountedFlaky.length > 0) {
      out.push(`  ${step.executed.discountedFlaky.length} failure(s) discounted as flaky per CI history — listed below, so you can disagree:`);
      for (const f of step.executed.discountedFlaky) out.push(`    • ${f.test}${f.file ? ` (${f.file})` : ""}: ${f.message}`);
    }
    return out.join("\n");
  }

  // --- work / exhausted: what's left ---
  out.push(`Outstanding (${step.outstanding.length})`);
  for (const line of step.outstanding.slice(0, 10)) out.push(`${BULLET} ${line}`);
  if (step.outstanding.length > 10) out.push(`     … ${step.outstanding.length - 10} more`);
  out.push("");

  if (step.status === "exhausted") {
    out.push(`EXHAUSTED — ${step.attempt} of ${step.maxAttempts} attempts used and still not green.`);
    out.push("  Keel is issuing no further tasks. Escalate: the remaining breaks are listed above.");
    return out.join("\n");
  }

  const task = step.task;
  if (!task) return out.join("\n");

  out.push(`NEXT TASK (${task.remaining} more behind it) — edit ${task.kind === "manifest" ? "the manifest" : "source"}`);
  out.push(`  ${task.title}`);
  if (task.targetFile) out.push(`  file to edit: ${task.targetFile}`);
  if (task.failure?.graphPath && task.failure.graphPath.length > 1) {
    out.push(`  graph path:   ${task.failure.graphPath.join(" → ")}`);
  }
  if (task.symbolsInPlay && task.symbolsInPlay.length > 0) {
    // "*" is the scanner's honest over-approximation — a namespace import, or a `require` whose
    // result it couldn't attribute to names. Spelling that out beats printing a bare asterisk.
    const whole = task.symbolsInPlay.includes("*");
    const named = task.symbolsInPlay.filter((s) => s !== "*");
    const detail = whole
      ? `the whole module${named.length > 0 ? ` (named: ${named.join(", ")})` : ""} — keel could not narrow this file's import to specific exports, so treat every export as in play`
      : named.join(", ");
    out.push(`  symbols used here: ${detail}`);
  }
  if (task.failure?.trace) {
    out.push("");
    out.push("  Trace");
    out.push(indent(task.failure.trace, 4));
  }
  if (task.installSignal) {
    out.push("");
    out.push("  npm said");
    for (const line of task.installSignal.evidence.slice(0, 6)) out.push(`    ${line}`);
  }
  if (task.source) {
    out.push("");
    out.push(`  ${task.source.file}`);
    out.push(indent(task.source.text, 4));
  }
  out.push(...renderEvidence(task.evidence));

  if (task.pastRepairs && task.pastRepairs.length > 0) {
    out.push("");
    out.push("  This package has been repaired here before — the migration may already be worked out:");
    for (const repair of task.pastRepairs) {
      out.push(`    ${repair.from ?? "?"} → ${repair.to} (${repair.occurredAt.slice(0, 10)})`);
      out.push(indent(truncateLines(repair.patch, 20), 6));
    }
  }

  out.push("");
  out.push("Write the patch, then re-run with --patch <file> --attempt " + (step.attempt + 1) + " to prove it.");
  return out.join("\n");
}

/** The package's own account of the change — and, just as importantly, where it has none. */
function renderEvidence(evidence: RepairTask["evidence"]): string[] {
  if (!evidence) return [];
  const out: string[] = ["", `  Package evidence (${evidence.fromVersion ?? "?"} → ${evidence.toVersion ?? "?"})`];

  if (evidence.changelog) {
    const scope = evidence.changelog.spanned ? "the span between the two versions" : "the TOP of the file — NOT the span between the versions";
    out.push(`    ${evidence.changelog.file} — ${scope}`);
    if (evidence.changelog.symbolMentions.length > 0) {
      out.push("    lines naming a symbol you use:");
      for (const line of evidence.changelog.symbolMentions) out.push(`      ${line.trim()}`);
    }
    out.push(indent(evidence.changelog.excerpt, 6));
  }
  if (evidence.diff) {
    out.push(`    the package's own diff (${evidence.diff.files.join(", ")})${evidence.diff.truncated ? " — truncated" : ""}`);
    out.push(indent(evidence.diff.patch, 6));
  }
  for (const note of evidence.notes) out.push(`    note: ${note}`);
  return out;
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text.split("\n").map((l) => pad + l).join("\n");
}

/** Icons for a batch summary line — outcome is the first thing a reader should be able to scan. */
const OUTCOME_MARK: Record<string, string> = {
  "auto-merge": "✓",
  "needs-review": "·",
  blocked: "✗",
  pinned: "⊘",
  "not-run": "?",
};

/**
 * Rendering a batch. Ordered as it ran — safest first — with the risk score and its components
 * shown, so the ranking can be argued with rather than trusted. The summary leads because the
 * question a batch answers is "how much of this can I merge?", and `not-run` is called out
 * separately because "we didn't look" must never read like "nothing found".
 */
export function renderBatchResult(result: BatchResult): string {
  const out: string[] = [];
  const s = result.summary;
  out.push(`keel upgrade --batch — ${result.entries.length} package(s)`);
  out.push(
    `  ${s["auto-merge"]} auto-merge · ${s["needs-review"]} need review · ${s.blocked} blocked · ` +
      `${s.pinned} pinned · ${s["not-run"]} NOT RUN`,
  );
  out.push(`  budget ${result.budget.usedSeconds}s of ${result.budget.maxSeconds}s${result.budget.exhausted ? " — EXHAUSTED" : ""}`);
  out.push(`  policy: ${result.policySource === "file" ? "keel.policy.json" : "defaults (nothing can auto-merge)"}`);
  out.push("");

  out.push("Ranked by risk, and run in this order (safest first, so a truncated batch lands the most)");
  for (const entry of result.entries) {
    const f = entry.riskFactors;
    out.push(
      `${BULLET} ${OUTCOME_MARK[entry.outcome] ?? "·"} ${entry.package}@${entry.requested} ` +
        `— ${entry.outcome} (risk ${entry.risk.toFixed(2)})`,
    );
    out.push(`      ${entry.reason}`);
    out.push(
      `      risk from: ${(f.shareOfRepo * 100).toFixed(1)}% of repo, ` +
        `${(f.uncoveredShare * 100).toFixed(0)}% of surface untested, ${f.versionJump} version jump` +
        `${f.pinnedByDecision ? ", a recorded decision mentions it" : ""}`,
    );
    if (entry.pr) out.push(`      PR ready: ${entry.pr.branch}${entry.pr.autoMergeable ? " (auto-mergeable)" : ""}`);
  }
  out.push("");

  const proposals = result.entries.filter((e) => e.pr);
  if (proposals.length > 0) {
    out.push(`${proposals.length} PR proposal(s) — keel composed these; it does NOT push branches or open PRs.`);
    out.push("  Each body carries the executed proof. Run the commands yourself, or take them from --json:");
    for (const entry of proposals.slice(0, 3)) {
      out.push(`${BULLET} ${entry.pr!.title}`);
      for (const command of entry.pr!.commands) out.push(indent(command, 6));
    }
    if (proposals.length > 3) out.push(`     … ${proposals.length - 3} more in --json`);
    out.push("");
  }

  for (const note of result.notes) out.push(`note: ${note}`);
  return out.join("\n");
}
