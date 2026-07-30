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
import * as fs from "node:fs";
import * as path from "node:path";
import { transitiveDependents, type FileGraph } from "../graph/dependencies.js";
import { toRepoRelative } from "../graph/shared.js";
import { canonicalPath } from "../util/platform.js";
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
  /** anything that makes the numbers above mean less than they appear to */
  notes: string[];
}

/**
 * Does `specifier` refer to `pkg`? Exact match, or a subpath import (`lodash/fp`), which is the same
 * dependency and breaks the same way. Scoped names work unchanged (`@scope/pkg`, `@scope/pkg/sub`).
 */
export function specifierMatchesPackage(specifier: string, pkg: string): boolean {
  return specifier === pkg || specifier.startsWith(`${pkg}/`);
}

/**
 * Is this package actually in-repo source wearing a dependency's name? A workspace package or a
 * `file:`/`link:` dependency installs as a symlink from node_modules to a directory inside the repo,
 * and the graph — correctly — resolves imports of it to those real files. They are therefore ordinary
 * in-repo edges, NOT external specifiers, so an upgrade scope would find zero import sites and report
 * a confident-looking zero. Detecting the link is what lets us say why instead.
 */
function linkedInRepo(repoRoot: string, pkg: string): string | null {
  const link = path.join(repoRoot, "node_modules", ...pkg.split("/"));
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  const real = canonicalPath(link);
  const root = canonicalPath(repoRoot);
  return real === root || real.startsWith(root + path.sep) ? toRepoRelative(root, real) : null;
}

/**
 * Scope an upgrade of `pkg` over an already-built graph. `repoRoot` is optional and used only to
 * explain an empty result (see linkedInRepo); the analysis itself is pure.
 */
export function scopeUpgrade(graph: FileGraph, pkg: string, repoRoot?: string): UpgradeScope {
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

  const notes: string[] = [];
  const linked = repoRoot ? linkedInRepo(repoRoot, pkg) : null;
  if (linked) {
    notes.push(
      `${pkg} is linked to in-repo source at ${linked} (a workspace package or a file:/link: ` +
        `dependency), so keel's graph treats imports of it as ordinary in-repo edges rather than ` +
        `external ones. Changing it is a source change, not a dependency upgrade — use get_impact or ` +
        `preflight on those files instead.`,
    );
  } else if (importSites.length === 0) {
    notes.push(`no file in the graph imports ${pkg} — either it is unused, or it is reached only through a dependency of a dependency`);
  }

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
    notes,
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
