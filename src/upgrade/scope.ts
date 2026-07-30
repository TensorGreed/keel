/**
 * Upgrade scope: which files actually touch a package, and what that reaches.
 *
 * The graph already knows this. Every file's import specifiers that resolved to nothing in-repo are
 * retained as `FileGraph.externalImports` (added for cross-repo workspaces, graph format v4) — and a
 * dependency is exactly that: an import that doesn't resolve inside the repo. So finding the import
 * sites for `lodash` is a lookup, not a new analysis, and it inherits the scanners' understanding of
 * each language's import syntax for free.
 *
 * From those sites the existing engines do the rest: `transitiveDependents` for the union blast
 * radius, `selectTests` for the covering tests and what they miss. The output is deliberately blunt
 * about its own limits — the share of the repo reached and the part of the surface no test covers
 * are the two numbers that decide whether an upgrade's green run means anything.
 */
import { transitiveDependents, type FileGraph } from "../graph/dependencies.js";
import { isTestFile, selectTests, type TestSelection } from "../simulate/select-tests.js";

export interface UpgradeScope {
  /** the package as named on the command line */
  package: string;
  /** files with a direct import of the package, sorted */
  importSites: string[];
  /** the exact specifiers seen at those sites (`lodash`, `lodash/fp`, …) — subpaths count */
  specifiers: string[];
  /** import sites + everything that transitively depends on them (the union blast radius), sorted */
  surface: string[];
  /** surface size as a share of the repo's graph, 0–1 and rounded to 3dp */
  shareOfRepo: number;
  /** test files covering any import site */
  testsSelected: string[];
  /** files in the surface that no selected test reaches — where a green run proves nothing */
  uncoveredSurface: string[];
  /** test file -> shortest import chain back to an import site: [test, …, site] */
  paths: Record<string, string[]>;
}

/**
 * Does `specifier` refer to `pkg`? Exact match, or a subpath import (`lodash/fp`), which is the same
 * dependency and breaks the same way. Scoped names work unchanged (`@scope/pkg`, `@scope/pkg/sub`).
 */
export function specifierMatchesPackage(specifier: string, pkg: string): boolean {
  return specifier === pkg || specifier.startsWith(`${pkg}/`);
}

/** Scope an upgrade of `pkg` over an already-built graph. Pure: no IO, no execution. */
export function scopeUpgrade(graph: FileGraph, pkg: string): UpgradeScope {
  const importSites: string[] = [];
  const specifiers = new Set<string>();
  for (const [file, specs] of graph.externalImports) {
    let hit = false;
    for (const spec of specs) {
      if (!specifierMatchesPackage(spec, pkg)) continue;
      hit = true;
      specifiers.add(spec);
    }
    if (hit) importSites.push(file);
  }
  importSites.sort();

  // The blast radius is the union over every site: a dependent of ANY site is exposed to the bump.
  const surface = new Set(importSites);
  for (const site of importSites) for (const dependent of transitiveDependents(graph, site)) surface.add(dependent);

  const selection: TestSelection = selectTests(graph, importSites);
  const testsSelected = selection.tests.map((t) => t.file).sort();

  // Covered = anything a selected test transitively reaches. Reuse the selection's own reachability
  // rather than recomputing it: a test covers a file iff that file is among the roots it reached,
  // so walk the surface and ask which entries are reachable from some selected test.
  const covered = coveredBySelectedTests(graph, testsSelected);
  const uncoveredSurface = [...surface].filter((f) => !isTestFile(f) && !covered.has(f)).sort();

  const total = graph.files.length;
  return {
    package: pkg,
    importSites,
    specifiers: [...specifiers].sort(),
    surface: [...surface].sort(),
    shareOfRepo: total > 0 ? Number((surface.size / total).toFixed(3)) : 0,
    testsSelected,
    uncoveredSurface,
    paths: selection.paths,
  };
}

/** Every source file the given tests transitively import — what a green run would actually exercise. */
function coveredBySelectedTests(graph: FileGraph, tests: string[]): Set<string> {
  const seen = new Set<string>(tests);
  const queue = [...tests];
  for (let i = 0; i < queue.length; i++) {
    for (const dep of graph.imports.get(queue[i]!) ?? []) {
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return seen;
}
