/**
 * `keel report --arch` — list every architectural-rule violation across the whole repo (not
 * just a change), so a team can adopt `forbiddenImports` rules on a legacy codebase and see
 * the debt before it gates anyone. The verdict blocks only edges a change introduces or
 * retains; this shows all of them, informationally (exit 0). Lazy-loaded from index.ts.
 */
import * as path from "node:path";
import { loadGraph } from "../graph/cache.js";
import { loadPolicy } from "./policy.js";
import { findForbiddenEdges, describeViolation, type ArchViolation } from "./arch.js";

const REPORT_HELP = `keel report — repo-wide reports from keel.policy.json

Usage: keel report --arch [--json]

  --arch   list every forbiddenImports violation in the repo (informational; exit 0)
  --json   emit the violations as JSON

Reads keel.policy.json and the repo from KEEL_REPO or the cwd.`;

function warn(message: string): void {
  process.stderr.write(`[keel] ${message}\n`);
}

async function archReport(repoRoot: string): Promise<{ violations: ArchViolation[]; ruleCount: number } | { error: string }> {
  const loaded = loadPolicy(repoRoot);
  if ("error" in loaded) return { error: loaded.error };
  const rules = loaded.policy.forbiddenImports;
  if (rules.length === 0) return { violations: [], ruleCount: 0 };
  const { graph } = await loadGraph(repoRoot);
  return { violations: findForbiddenEdges(graph, rules), ruleCount: rules.length };
}

export async function runReport(argv: string[]): Promise<number> {
  let arch = false;
  let asJson = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(REPORT_HELP);
      return 0;
    }
    if (arg === "--arch") arch = true;
    else if (arg === "--json") asJson = true;
    else {
      warn(`report: unexpected argument ${arg}`);
      return 1;
    }
  }
  if (!arch) {
    warn("report: nothing to do — pass --arch");
    return 1;
  }

  const repoRoot = path.resolve(process.env["KEEL_REPO"] ?? process.cwd());
  const result = await archReport(repoRoot);
  if ("error" in result) {
    if (asJson) console.log(JSON.stringify({ error: result.error }, null, 2));
    else warn(`report failed: ${result.error}`);
    return 1;
  }

  if (asJson) {
    console.log(JSON.stringify({ ruleCount: result.ruleCount, violations: result.violations }, null, 2));
    return 0;
  }

  if (result.ruleCount === 0) {
    warn("no forbiddenImports rules in keel.policy.json — nothing to report.");
    return 0;
  }
  if (result.violations.length === 0) {
    warn(`no forbidden import edges found (${result.ruleCount} rule(s) checked). The repo is clean.`);
    return 0;
  }
  warn(`${result.violations.length} forbidden import edge(s) across the repo (${result.ruleCount} rule(s)):`);
  for (const v of result.violations) warn(`  ✗ ${describeViolation(v)}`);
  warn("These inform adoption; the verdict blocks only edges a change introduces or retains.");
  return 0;
}
