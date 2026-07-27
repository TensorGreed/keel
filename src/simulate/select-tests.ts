/**
 * Test selection (imports v0): map test files to the source files they cover, then pick
 * the tests to run for a change. A test "covers" a source file when it transitively imports
 * it, so the tests relevant to changing file C are exactly the test files among C's
 * transitive dependents (plus C itself, if C is a test).
 *
 * Pure static analysis over the cached graph — no execution (the sandbox runner consumes
 * this next). Coverage here is import reachability, not runtime coverage: a safe
 * overapproximation. Changed source files that no test reaches are reported as
 * uncoveredChanges — a trust signal the simulator surfaces rather than hides.
 */
import { isGraphSourcePath, type FileGraph } from "../graph/dependencies.js";
import type { ChangedFile } from "./impact.js";

export interface SelectedTest {
  file: string;
  /** changed source files this test transitively imports (sorted) */
  covers: string[];
}

export interface TestSelection {
  tests: SelectedTest[];
  /** test file -> shortest import path to a covered changed file: [test, ..., changed] */
  paths: Record<string, string[]>;
  /** changed source files no selected test reaches */
  uncoveredChanges: string[];
  testCount: number;
}

const TEST_FILE_RE = /\.(test|spec)\.(c|m)?[jt]sx?$/;
const TEST_DIRS = new Set(["__tests__", "test", "tests"]);

/** Whether a repo-relative source path is a test file, by convention. */
export function isTestFile(relPosixPath: string): boolean {
  if (!isGraphSourcePath(relPosixPath)) return false;
  const segments = relPosixPath.split("/");
  const base = segments[segments.length - 1] ?? "";
  if (TEST_FILE_RE.test(base)) return true;
  return segments.slice(0, -1).some((seg) => TEST_DIRS.has(seg));
}

/** The source files a test covers: everything it transitively imports, minus other tests. */
export function coverageOf(graph: FileGraph, testFile: string): string[] {
  const seen = new Set<string>();
  const queue = [testFile];
  for (let i = 0; i < queue.length; i++) {
    for (const dep of graph.imports.get(queue[i]!) ?? []) {
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  seen.delete(testFile);
  return [...seen].filter((f) => !isTestFile(f)).sort();
}

/**
 * The baseline graph nodes whose dependents propagate, derived from a change set. For a
 * rename that's the old path (consumers still reference it); for a deletion the path is
 * already the old path; modifications and additions use the path itself. Non-source files
 * (docs, JSON) don't propagate and are dropped.
 */
export function changedRoots(changedFiles: ChangedFile[]): string[] {
  const roots = new Set<string>();
  for (const file of changedFiles) {
    if (!file.inGraph) continue;
    roots.add(file.status === "renamed" && file.oldPath ? file.oldPath : file.path);
  }
  return [...roots];
}

/** Select the test files that cover any of the changed roots, with why and what's uncovered. */
export function selectTests(graph: FileGraph, roots: string[]): TestSelection {
  const covers = new Map<string, Set<string>>();
  const paths = new Map<string, string[]>();
  const coveredRoots = new Set<string>();

  const consider = (test: string, root: string, chain: string[]): void => {
    let set = covers.get(test);
    if (!set) {
      set = new Set();
      covers.set(test, set);
    }
    set.add(root);
    const existing = paths.get(test);
    if (!existing || chain.length < existing.length) paths.set(test, chain);
    coveredRoots.add(root);
  };

  for (const root of new Set(roots)) {
    if (isTestFile(root)) consider(root, root, [root]); // a changed test covers itself
    if (!graph.imports.has(root)) continue;

    // BFS over dependents (importedBy) to find every test that reaches this root.
    const pred = new Map<string, string | null>([[root, null]]);
    const queue = [root];
    for (let i = 0; i < queue.length; i++) {
      for (const dependent of graph.importedBy.get(queue[i]!) ?? []) {
        if (!pred.has(dependent)) {
          pred.set(dependent, queue[i]!);
          queue.push(dependent);
        }
      }
    }
    for (const node of pred.keys()) {
      if (node === root || !isTestFile(node)) continue;
      const chain: string[] = [];
      let cursor: string | null = node;
      while (cursor != null) {
        chain.push(cursor);
        cursor = pred.get(cursor) ?? null;
      }
      consider(node, root, chain);
    }
  }

  const tests = [...covers.keys()]
    .sort()
    .map((file) => ({ file, covers: [...covers.get(file)!].sort() }));
  const uncoveredChanges = roots.filter((r) => !coveredRoots.has(r) && !isTestFile(r)).sort();

  return {
    tests,
    paths: Object.fromEntries([...paths].sort(([a], [b]) => a.localeCompare(b))),
    uncoveredChanges: [...new Set(uncoveredChanges)],
    testCount: tests.length,
  };
}

/** Convenience: the full test -> covered-sources map for the whole repo. */
export function testCoverageMap(graph: FileGraph): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const file of graph.files) {
    if (isTestFile(file)) map[file] = coverageOf(graph, file);
  }
  return map;
}
