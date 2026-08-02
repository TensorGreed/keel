/**
 * Rendering the selection evidence. The escape rate leads, because it is the number that decides
 * whether the selectivity number below it is a benefit or a liability.
 */
import type { SelectionEvidence } from "./selection.js";

export function renderSelectionEvidence(result: SelectionEvidence): string {
  const s = result.summary;
  const out: string[] = [];
  out.push(`keel evidence: test selection — ${result.repo}`);
  out.push(`  ${result.head?.slice(0, 8) ?? "?"} · seed ${result.seed} · ${result.trials.length} trial(s) in ${Math.round(result.durationMs / 1000)}s`);
  out.push("");

  if (s.measured === 0) {
    out.push("NOTHING MEASURED — no trial produced a fault the suite noticed.");
    out.push(`  ${s.undetected} undetected, ${s.collapsed} collapsed, ${s.skipped} skipped.`);
    out.push("  This says nothing about keel; it says the faults landed where the suite doesn't look.");
    return out.join("\n");
  }

  const escapeRate = s.escapeRate ?? 0;
  out.push(`ESCAPE RATE ${(escapeRate * 100).toFixed(1)}%  (${s.escaped} of ${s.measured} measured trial(s))`);
  out.push(
    s.escaped === 0
      ? "  Every fault the suite caught was caught by a test keel selected."
      : "  A test failed that keel did NOT select — preflight would have reported green on a real break.",
  );
  out.push("");
  out.push(`SELECTIVITY ${((s.selectivity ?? 0) * 100).toFixed(1)}%  — keel ran ${s.meanSelected} of ${result.totalTests} test file(s) on average`);
  out.push(
    s.escaped === 0
      ? "  That saving is real only because nothing escaped."
      : "  Discount this entirely until the escape rate is zero.",
  );
  out.push("");

  out.push("Trials");
  for (const trial of result.trials) {
    const mark = { caught: "✓", escaped: "✗", undetected: "·", collapsed: "!", skipped: "-" }[trial.outcome];
    const mutation = trial.mutation ? ` [${trial.mutation.from} → ${trial.mutation.to} @ ${trial.mutation.line}]` : "";
    out.push(`  ${mark} ${trial.outcome.padEnd(10)} ${trial.file}${mutation}`);
    if (trial.outcome === "caught") out.push(`      selected ${trial.selected}, failed ${trial.failed.length} — all selected`);
    if (trial.outcome === "escaped") out.push(`      ESCAPED: ${trial.escapes.join(", ")} (selected ${trial.selected})`);
    if (trial.reason) out.push(`      ${trial.reason}`);
  }
  out.push("");

  // The excluded trials are stated, not hidden: they bound how much this run actually measured.
  out.push(
    `Excluded from the escape rate: ${s.undetected} undetected (the suite doesn't cover that code), ` +
      `${s.collapsed} collapsed (the fault broke the build), ${s.skipped} skipped.`,
  );
  for (const note of result.notes) out.push(`note: ${note}`);
  return out.join("\n");
}
