/**
 * Risk hotspots: rank files by where a change is most likely to bite. Risk composes three
 * signals the substrate already has — churn (commits touching the file in a trailing window,
 * from the event log), blast radius (transitive dependents, from the cached graph), and a
 * coverage gap (no test reaches it, from the select_tests machinery):
 *
 *     score = churn × (blastRadius + 1) × coverageGap
 *
 * (blastRadius + 1 keeps a churny leaf from zeroing out; coverageGap is 2 when uncovered, 1
 * when covered.) The report shows every component, not just the score — the point is to explain
 * *why* a file is risky, not hand down a number. Pure analysis: no I/O here, no model calls.
 */
import { isGraphSourcePath, transitiveDependents, type FileGraph } from "../graph/dependencies.js";
import { coverageOf, isTestFile } from "../simulate/select-tests.js";

export interface Hotspot {
  path: string;
  /** commits touching the file in the window */
  commits: number;
  blastRadius: number;
  covered: boolean;
  score: number;
}

/** Multiplier applied when no test reaches a file — an uncovered change is riskier. */
const UNCOVERED_PENALTY = 2;

/** The set of source files some test file transitively imports (i.e. is covered). */
export function coveredFiles(graph: FileGraph): Set<string> {
  const covered = new Set<string>();
  for (const file of graph.files) {
    if (isTestFile(file)) for (const src of coverageOf(graph, file)) covered.add(src);
  }
  return covered;
}

/**
 * Rank non-test source files by risk, highest first. Only files with churn in the window are
 * hotspots (a file nothing has touched isn't hot), so score-0 files are dropped. Ties break by
 * churn, then blast radius, then path — deterministic.
 */
export function computeHotspots(
  graph: FileGraph,
  churn: Map<string, number>,
  covered: Set<string>,
  options: { limit?: number } = {},
): Hotspot[] {
  const hotspots: Hotspot[] = [];
  for (const file of graph.files) {
    if (isTestFile(file) || !isGraphSourcePath(file)) continue;
    const commits = churn.get(file) ?? 0;
    if (commits === 0) continue; // no recent churn → not a hotspot
    const blastRadius = transitiveDependents(graph, file).length;
    const isCovered = covered.has(file);
    const score = commits * (blastRadius + 1) * (isCovered ? 1 : UNCOVERED_PENALTY);
    hotspots.push({ path: file, commits, blastRadius, covered: isCovered, score });
  }
  hotspots.sort(
    (a, b) => b.score - a.score || b.commits - a.commits || b.blastRadius - a.blastRadius || a.path.localeCompare(b.path),
  );
  const limit = options.limit && options.limit > 0 ? options.limit : hotspots.length;
  return hotspots.slice(0, limit);
}

/** One aligned line describing a hotspot's components — the report never hides the inputs. */
export function describeHotspot(h: Hotspot): string {
  const cov = h.covered ? "covered" : "UNCOVERED";
  return `${String(h.score).padStart(6)}  ${String(h.commits).padStart(3)} commits  br ${String(h.blastRadius).padStart(4)}  ${cov.padEnd(9)}  ${h.path}`;
}
