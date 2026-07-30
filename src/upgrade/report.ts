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
  out.push("");

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
  out.push(`  status: ${report.install.ok ? "completed" : `FAILED${report.install.exitCode !== null ? ` (exit ${report.install.exitCode})` : ""}`}`);
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

function renderFailure(f: UpgradeFailure): string[] {
  const lines = [`${BULLET} FAIL ${f.test}${f.file ? ` (${f.file})` : ""}`];
  lines.push(`      ${f.message}`);
  if (f.importSite) lines.push(`      import site: ${f.importSite}`);
  if (f.graphPath && f.graphPath.length > 1) lines.push(`      graph path:  ${f.graphPath.join(" → ")}`);
  if (f.kind === "collection-error") lines.push("      (the test file could not even be loaded)");
  return lines;
}
