/**
 * System graph: the file-level import graph for a repo. This module is language-agnostic — it
 * walks the tree, hands each file to the LanguageScanner that owns its extension, resolves the
 * scanned specifiers to in-repo files, and assembles the graph. All language specifics
 * (parsing, module resolution) live behind the scanner seam (scanner.ts + the per-language
 * scanners registered in scanners.ts). Symbol-level edges and multi-language support build on
 * this composition; see docs/architecture.md.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { graphRoot, IGNORED_DIRS, toRepoRelative } from "./shared.js";
import type { EdgeKind, LanguageScanner } from "./scanner.js";
import { createScanners, GRAPH_EXTENSIONS } from "./scanners.js";
import { applySpringEdges, javaFiles } from "./spring.js";

/** Priority when an edge has more than one provenance: a real import outranks DI outranks adjacency. */
const KIND_RANK: Record<EdgeKind, number> = { import: 3, di: 2, package: 1 };
/** The higher-priority of two kinds; when nothing is recorded yet (undefined), take the new one. */
function strongerKind(a: EdgeKind | undefined, b: EdgeKind): EdgeKind {
  return a === undefined || KIND_RANK[b] > KIND_RANK[a] ? b : a;
}

export interface FileGraph {
  /** file -> files it imports (repo-relative posix paths) */
  imports: Map<string, Set<string>>;
  /** file -> files that import it */
  importedBy: Map<string, Set<string>>;
  /**
   * importer -> (imported file -> symbols used). "default" is the default export,
   * "*" means the whole module (namespace object escaping, dynamic import, require).
   * An empty set is a side-effect-only import.
   */
  importSymbols: Map<string, Map<string, Set<string>>>;
  /** file -> its exported names ("default"; "*" when it re-exports everything from another module) */
  exportsOf: Map<string, Set<string>>;
  /**
   * file -> import specifiers that did NOT resolve to an in-repo file (third-party packages, stdlib,
   * or — the point of this — a package published by a *sibling repo* in a workspace). Retained here
   * so the workspace layer can resolve cross-repo edges without re-scanning (see src/workspace/).
   */
  externalImports: Map<string, Set<string>>;
  /**
   * importer -> (imported file -> edge provenance), storing only NON-default kinds ("package"/"di").
   * An edge absent here is a plain "import". Lets a report explain why a same-package pair shows up
   * as mutual "*" edges (it's package-unit adjacency, not a suspected analyzer artifact). See EdgeKind.
   */
  edgeKind: Map<string, Map<string, EdgeKind>>;
  /** all scanned source files */
  files: string[];
}

/** A directed edge with its provenance (see EdgeKind), parallel to the flat dependency arrays. */
export interface EdgeInfo {
  file: string;
  kind: EdgeKind;
}

export interface DependencyReport {
  file: string;
  /** files this file directly imports */
  dependencies: string[];
  /** files that directly import this file */
  dependents: string[];
  /** every file that transitively depends on this file (the blast radius) */
  transitiveDependents: string[];
  /** names this file exports ("default"; "*" = re-exports everything from another module) */
  exports: string[];
  /** dependency file -> symbols this file imports from it (see FileGraph.importSymbols) */
  importsFrom: Record<string, string[]>;
  /** dependent file -> exports of this file it actually uses */
  usedBy: Record<string, string[]>;
  /** `dependencies`, each with how the edge arises ("import" | "package" | "di"). Same order. */
  edges: EdgeInfo[];
  /** `dependents`, each with how the incoming edge arises. Same order. */
  dependentEdges: EdgeInfo[];
}

function listSourceFiles(root: string): string[] {
  const results: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          walk(path.join(dir, entry.name));
        }
      } else if (GRAPH_EXTENSIONS.has(path.extname(entry.name))) {
        results.push(path.join(dir, entry.name));
      }
    }
  };
  walk(root);
  return results;
}

/** The per-file outputs the graph is assembled from: resolved edges, per-target symbols, and
 *  exports. Produced by handing the file to the scanner for its extension. */
interface FileScan {
  imports: Set<string>;
  importSymbols: Map<string, Set<string>>;
  exports: Set<string>;
  /** specifiers that resolved to nothing in-repo (candidates for cross-repo resolution) */
  external: Set<string>;
  /** target -> non-default edge kind for this file's outgoing edges (only "package" from scanners) */
  edgeKind: Map<string, EdgeKind>;
}

function emptyScan(): FileScan {
  return { imports: new Set(), importSymbols: new Map(), exports: new Set(), external: new Set(), edgeKind: new Map() };
}

/** extension -> the scanner that owns it (first scanner wins on overlap). */
function scannersByExtension(scanners: LanguageScanner[]): Map<string, LanguageScanner> {
  const map = new Map<string, LanguageScanner>();
  for (const scanner of scanners) {
    for (const ext of scanner.extensions) if (!map.has(ext)) map.set(ext, scanner);
  }
  return map;
}

/**
 * Scan one file: pick the scanner for its extension, parse its content, and resolve each
 * scanned specifier to an in-repo file — the language-agnostic half of graph building.
 */
function scanFile(byExtension: Map<string, LanguageScanner>, root: string, absFile: string): FileScan | null {
  const scanner = byExtension.get(path.extname(absFile));
  if (!scanner) return null;
  let content: string;
  try {
    content = fs.readFileSync(absFile, "utf8");
  } catch {
    return null;
  }

  const result = scanner.scanFile(absFile, content);
  const imports = new Set<string>();
  const importSymbols = new Map<string, Set<string>>();
  const external = new Set<string>();
  const kinds = new Map<string, EdgeKind>();
  for (const { specifier, symbols, kind } of result.imports) {
    const resolved = scanner.resolveImport(specifier, absFile);
    if (!resolved) {
      external.add(specifier); // no in-repo target — a third-party package, or a workspace sibling's
      continue;
    }
    // A specifier resolves to one file (TS/Python) or many (a Go package's files). Edge to each.
    for (const target of Array.isArray(resolved) ? resolved : [resolved]) {
      const rel = toRepoRelative(root, target);
      if (rel === toRepoRelative(root, absFile)) continue; // never a self-edge
      imports.add(rel);
      let set = importSymbols.get(rel);
      if (!set) {
        set = new Set();
        importSymbols.set(rel, set);
      }
      for (const symbol of symbols) set.add(symbol);
      // Record provenance; a real import to the same target outranks same-package adjacency.
      kinds.set(rel, strongerKind(kinds.get(rel), kind ?? "import"));
    }
  }
  // Store only non-default kinds — "import" is the default and needn't be persisted.
  const edgeKind = new Map<string, EdgeKind>();
  for (const [rel, k] of kinds) if (k !== "import") edgeKind.set(rel, k);
  return { imports, importSymbols, exports: result.exports, external, edgeKind };
}

/** Invert file -> imports into file -> importedBy (importedBy is fully derived). */
function invertImports(imports: Map<string, Set<string>>): Map<string, Set<string>> {
  const importedBy = new Map<string, Set<string>>();
  for (const [file, targets] of imports) {
    for (const target of targets) {
      let set = importedBy.get(target);
      if (!set) {
        set = new Set();
        importedBy.set(target, set);
      }
      set.add(file);
    }
  }
  return importedBy;
}

/** Build the file-level import graph for a repo. */
export function buildFileGraph(repoRoot: string): FileGraph {
  const root = graphRoot(repoRoot);
  const byExtension = scannersByExtension(createScanners(root));
  const imports = new Map<string, Set<string>>();
  const importSymbols = new Map<string, Map<string, Set<string>>>();
  const exportsOf = new Map<string, Set<string>>();
  const externalImports = new Map<string, Set<string>>();
  const edgeKind = new Map<string, Map<string, EdgeKind>>();
  const relFiles: string[] = [];

  for (const file of listSourceFiles(root)) {
    const rel = toRepoRelative(root, file);
    relFiles.push(rel);
    const scan = scanFile(byExtension, root, file) ?? emptyScan();
    imports.set(rel, scan.imports);
    importSymbols.set(rel, scan.importSymbols);
    exportsOf.set(rel, scan.exports);
    if (scan.external.size > 0) externalImports.set(rel, scan.external);
    if (scan.edgeKind.size > 0) edgeKind.set(rel, scan.edgeKind);
  }

  // Spring DI enrichment: add the runtime wiring edges imports can't express (interface →
  // implementation, @Bean factories), labelled "di". Cross-file by nature, so it runs once here on
  // the full graph; a Java change forces a full rebuild rather than an incremental update (cache.ts).
  const java = javaFiles(relFiles);
  if (java.length > 0) applySpringEdges(root, java, imports, importSymbols, edgeKind);

  return {
    imports,
    importedBy: invertImports(imports),
    importSymbols,
    exportsOf,
    externalImports,
    edgeKind,
    files: relFiles.sort(),
  };
}

/**
 * Incrementally rebuild a graph after only the *contents* of existing files changed —
 * no files added, removed, or resolver-config changes (the cache layer enforces that).
 * Under those conditions this is provably identical to a full buildFileGraph: an
 * unchanged file's edges depend on its own content, the resolver, and which files exist,
 * none of which moved, so only the modified files need rescanning.
 *
 * Exception: Spring DI edges are cross-file (an impl's file changes an injector's edges), so
 * a `.java` change breaks that assumption — the cache layer forces a full rebuild in that case
 * and never routes a Java change here. Non-Java changes leave the (Java-only) DI edges untouched,
 * so the invariant holds and the preserved base DI edges stay correct.
 */
export function updateFileGraph(
  repoRoot: string,
  base: FileGraph,
  modifiedFiles: Iterable<string>,
): FileGraph {
  const root = graphRoot(repoRoot);
  const byExtension = scannersByExtension(createScanners(root));
  const imports = new Map(base.imports);
  const importSymbols = new Map(base.importSymbols);
  const exportsOf = new Map(base.exportsOf);
  const externalImports = new Map(base.externalImports);
  const edgeKind = new Map(base.edgeKind);

  for (const rel of modifiedFiles) {
    const scan = scanFile(byExtension, root, path.resolve(root, rel)) ?? emptyScan();
    imports.set(rel, scan.imports);
    importSymbols.set(rel, scan.importSymbols);
    exportsOf.set(rel, scan.exports);
    if (scan.external.size > 0) externalImports.set(rel, scan.external);
    else externalImports.delete(rel);
    // A file's own outgoing edge kinds are recomputed from its rescan (no Java here — DI never
    // reaches this path, since a .java change forces a full rebuild).
    if (scan.edgeKind.size > 0) edgeKind.set(rel, scan.edgeKind);
    else edgeKind.delete(rel);
  }

  return { imports, importedBy: invertImports(imports), importSymbols, exportsOf, externalImports, edgeKind, files: base.files };
}

/** Everything that transitively depends on `file` — the blast radius of changing it. */
export function transitiveDependents(graph: FileGraph, file: string): string[] {
  const seen = new Set<string>();
  const queue = [file];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const dependent of graph.importedBy.get(current) ?? []) {
      if (!seen.has(dependent)) {
        seen.add(dependent);
        queue.push(dependent);
      }
    }
  }
  seen.delete(file);
  return [...seen].sort();
}

export function reportFor(graph: FileGraph, file: string): DependencyReport {
  const dependencies = [...(graph.imports.get(file) ?? [])].sort();
  const dependents = [...(graph.importedBy.get(file) ?? [])].sort();

  const importsFrom: Record<string, string[]> = {};
  for (const dependency of dependencies) {
    importsFrom[dependency] = [...(graph.importSymbols.get(file)?.get(dependency) ?? [])].sort();
  }
  const usedBy: Record<string, string[]> = {};
  for (const dependent of dependents) {
    usedBy[dependent] = [...(graph.importSymbols.get(dependent)?.get(file) ?? [])].sort();
  }

  // Edge provenance: outgoing edges are keyed by (file -> dependency); an incoming edge's kind is
  // keyed by (dependent -> file). Absent from edgeKind means the default "import".
  const kindOf = (from: string, to: string): EdgeKind => graph.edgeKind?.get(from)?.get(to) ?? "import";
  const edges = dependencies.map((dep) => ({ file: dep, kind: kindOf(file, dep) }));
  const dependentEdges = dependents.map((dep) => ({ file: dep, kind: kindOf(dep, file) }));

  return {
    file,
    dependencies,
    dependents,
    transitiveDependents: transitiveDependents(graph, file),
    exports: [...(graph.exportsOf.get(file) ?? [])].sort(),
    importsFrom,
    usedBy,
    edges,
    dependentEdges,
  };
}

/**
 * Whether a repo-relative posix path is a file the graph would scan — the single source
 * of truth for graph membership, so the cache classifies changed paths exactly as
 * listSourceFiles walks them (same extensions, same ignored dirs).
 */
export function isGraphSourcePath(relPosixPath: string): boolean {
  const segments = relPosixPath.split("/");
  if (segments.some((seg) => IGNORED_DIRS.has(seg) || (seg.startsWith(".") && seg !== "."))) {
    return false;
  }
  return GRAPH_EXTENSIONS.has(path.posix.extname(relPosixPath));
}

/** On-disk graph format; bump when the serialized shape changes OR when the edges a build produces
 *  change, so stale caches are dropped. v2: multi-language graphs (v1 was TS/JS-only). v3: Spring DI
 *  edges. v4: retained external import specifiers. v5: edge provenance (package/di kinds). */
export const GRAPH_FORMAT_VERSION = 5;

export interface SerializedFileGraph {
  version: number;
  files: string[];
  imports: [string, string[]][];
  importSymbols: [string, [string, string[]][]][];
  exportsOf: [string, string[]][];
  externalImports: [string, string[]][];
  edgeKind: [string, [string, EdgeKind][]][];
}

/** Convert a FileGraph to a JSON-serializable form (Maps/Sets -> arrays). importedBy is
 *  omitted — it's derived from imports on load. */
export function serializeFileGraph(graph: FileGraph): SerializedFileGraph {
  return {
    version: GRAPH_FORMAT_VERSION,
    files: graph.files,
    imports: [...graph.imports].map(([file, targets]) => [file, [...targets]]),
    importSymbols: [...graph.importSymbols].map(([file, byTarget]) => [
      file,
      [...byTarget].map(([target, symbols]) => [target, [...symbols]]),
    ]),
    exportsOf: [...graph.exportsOf].map(([file, names]) => [file, [...names]]),
    externalImports: [...graph.externalImports].map(([file, specs]) => [file, [...specs]]),
    edgeKind: [...graph.edgeKind].map(([file, byTarget]) => [file, [...byTarget]]),
  };
}

/** Rebuild a FileGraph from serialized form, validating shape. Returns null if the data
 *  is malformed or from an incompatible version — the caller then rebuilds from source. */
export function deserializeFileGraph(data: unknown): FileGraph | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Partial<SerializedFileGraph>;
  if (d.version !== GRAPH_FORMAT_VERSION) return null;
  if (
    !Array.isArray(d.files) || !Array.isArray(d.imports) || !Array.isArray(d.importSymbols) ||
    !Array.isArray(d.exportsOf) || !Array.isArray(d.externalImports) || !Array.isArray(d.edgeKind)
  ) {
    return null;
  }
  try {
    const imports = new Map<string, Set<string>>(
      d.imports.map(([file, targets]) => [file, new Set(targets)]),
    );
    const importSymbols = new Map<string, Map<string, Set<string>>>(
      d.importSymbols.map(([file, byTarget]) => [
        file,
        new Map(byTarget.map(([target, symbols]) => [target, new Set(symbols)])),
      ]),
    );
    const exportsOf = new Map<string, Set<string>>(
      d.exportsOf.map(([file, names]) => [file, new Set(names)]),
    );
    const externalImports = new Map<string, Set<string>>(
      d.externalImports.map(([file, specs]) => [file, new Set(specs)]),
    );
    const edgeKind = new Map<string, Map<string, EdgeKind>>(
      d.edgeKind.map(([file, byTarget]) => [file, new Map(byTarget)]),
    );
    return { imports, importedBy: invertImports(imports), importSymbols, exportsOf, externalImports, edgeKind, files: d.files };
  } catch {
    return null;
  }
}
