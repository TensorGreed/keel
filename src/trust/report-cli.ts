/**
 * `keel report` — repo-wide reports over the substrate, for adoption and triage (not gating a
 * single change). Two sections:
 *   --arch      every forbiddenImports violation in the repo (adopt a rule on a legacy codebase)
 *   --hotspots  files ranked by risk = churn × blast radius × coverage gap (where review bites)
 * With no section flag, prints both. Informational — exit 0 unless the invocation is malformed
 * or the policy can't be read. Lazy-loaded from index.ts.
 */
import * as path from "node:path";
import { loadGraph } from "../graph/cache.js";
import { SqliteEventStore } from "../events/sqlite-store.js";
import { ingestCommits } from "../events/ingest.js";
import { loadPolicy } from "./policy.js";
import { findForbiddenEdges, describeViolation, type ArchViolation } from "./arch.js";
import { computeHotspots, coveredFiles, describeHotspot, type Hotspot } from "./hotspots.js";

const DEFAULT_DAYS = 90;
const DEFAULT_LIMIT = 20;

const REPORT_HELP = `keel report — repo-wide reports from the graph, event log, and keel.policy.json

Usage: keel report [--arch] [--hotspots] [--days N] [--limit N] [--json]

  --arch       list every forbiddenImports violation in the repo
  --hotspots   rank files by risk = churn × blast radius × coverage gap
  --days N      churn window for --hotspots, in days (default ${DEFAULT_DAYS})
  --limit N     cap the hotspot list (default ${DEFAULT_LIMIT})
  --json        emit the report as JSON

With no section flag, prints both. Informational (exit 0). Reads keel.policy.json and the
repo from KEEL_REPO or the cwd.`;

function warn(message: string): void {
  process.stderr.write(`[keel] ${message}\n`);
}

interface ReportOptions {
  arch: boolean;
  hotspots: boolean;
  days: number;
  limit: number;
  asJson: boolean;
}

function parseArgs(argv: string[]): ReportOptions | { help: true } | { error: string } {
  const opts: ReportOptions = { arch: false, hotspots: false, days: DEFAULT_DAYS, limit: DEFAULT_LIMIT, asJson: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    else if (arg === "--arch") opts.arch = true;
    else if (arg === "--hotspots") opts.hotspots = true;
    else if (arg === "--json") opts.asJson = true;
    else if (arg === "--days" || arg === "--limit") {
      const value = argv[++i];
      const n = Number(value);
      if (value === undefined || !Number.isFinite(n) || n <= 0) return { error: `${arg} must be a positive integer, got "${value ?? ""}"` };
      if (arg === "--days") opts.days = Math.floor(n);
      else opts.limit = Math.floor(n);
    } else return { error: `unexpected argument ${arg}` };
  }
  // No section selected → both.
  if (!opts.arch && !opts.hotspots) {
    opts.arch = true;
    opts.hotspots = true;
  }
  return opts;
}

async function computeArch(repoRoot: string): Promise<{ violations: ArchViolation[]; ruleCount: number } | { error: string }> {
  const loaded = loadPolicy(repoRoot);
  if ("error" in loaded) return { error: loaded.error };
  const rules = loaded.policy.forbiddenImports;
  if (rules.length === 0) return { violations: [], ruleCount: 0 };
  const { graph } = await loadGraph(repoRoot);
  return { violations: findForbiddenEdges(graph, rules), ruleCount: rules.length };
}

async function computeHotspotSection(repoRoot: string, days: number, limit: number): Promise<{ days: number; hotspots: Hotspot[] }> {
  const store = new SqliteEventStore(path.join(repoRoot, ".keel", "events.db"));
  try {
    // Make churn reflect current history even if `keel serve` never ran here (idempotent).
    await ingestCommits(store, repoRoot).catch(() => undefined);
    const { graph } = await loadGraph(repoRoot);
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const hotspots = computeHotspots(graph, store.churnByFile(since), coveredFiles(graph), { limit });
    return { days, hotspots };
  } finally {
    store.close();
  }
}

export async function runReport(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ("help" in parsed) {
    console.log(REPORT_HELP);
    return 0;
  }
  if ("error" in parsed) {
    warn(`report: ${parsed.error}`);
    return 1;
  }
  const opts = parsed;
  const repoRoot = path.resolve(process.env["KEEL_REPO"] ?? process.cwd());

  const arch = opts.arch ? await computeArch(repoRoot) : undefined;
  if (arch && "error" in arch) {
    if (opts.asJson) console.log(JSON.stringify({ error: arch.error }, null, 2));
    else warn(`report failed: ${arch.error}`);
    return 1;
  }
  const hot = opts.hotspots ? await computeHotspotSection(repoRoot, opts.days, opts.limit) : undefined;

  if (opts.asJson) {
    console.log(
      JSON.stringify(
        {
          ...(arch ? { arch: { ruleCount: arch.ruleCount, violations: arch.violations } } : {}),
          ...(hot ? { hotspots: { days: hot.days, files: hot.hotspots } } : {}),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (arch) printArch(arch);
  if (hot) printHotspots(hot);
  return 0;
}

function printArch(arch: { violations: ArchViolation[]; ruleCount: number }): void {
  if (arch.ruleCount === 0) {
    warn("arch: no forbiddenImports rules in keel.policy.json.");
    return;
  }
  if (arch.violations.length === 0) {
    warn(`arch: no forbidden import edges found (${arch.ruleCount} rule(s) checked) — clean.`);
    return;
  }
  warn(`arch: ${arch.violations.length} forbidden import edge(s) across the repo (${arch.ruleCount} rule(s)):`);
  for (const v of arch.violations) warn(`  ✗ ${describeViolation(v)}`);
  warn("  (informational — the verdict blocks only edges a change introduces or retains)");
}

function printHotspots(hot: { days: number; hotspots: Hotspot[] }): void {
  if (hot.hotspots.length === 0) {
    warn(`hotspots: no files changed in the last ${hot.days} days (nothing to rank).`);
    return;
  }
  warn(`hotspots: top ${hot.hotspots.length} by risk = churn × blast radius × coverage gap (last ${hot.days} days):`);
  warn("   score  commits  blast    coverage   path");
  for (const h of hot.hotspots) warn(`  ${describeHotspot(h)}`);
}
