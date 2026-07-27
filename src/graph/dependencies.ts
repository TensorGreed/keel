/**
 * System graph v0: file-level import graph for TS/JS repos.
 *
 * Uses the TypeScript compiler API (preProcessFile + module resolution) so results
 * are deterministic and config-aware. Symbol-level edges and tree-sitter extraction
 * come later (see docs/architecture.md).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", "out"]);

export interface FileGraph {
  /** file -> files it imports (repo-relative posix paths) */
  imports: Map<string, Set<string>>;
  /** file -> files that import it */
  importedBy: Map<string, Set<string>>;
  /** all scanned source files */
  files: string[];
}

export interface DependencyReport {
  file: string;
  /** files this file directly imports */
  dependencies: string[];
  /** files that directly import this file */
  dependents: string[];
  /** every file that transitively depends on this file (the blast radius) */
  transitiveDependents: string[];
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
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        results.push(path.join(dir, entry.name));
      }
    }
  };
  walk(root);
  return results;
}

function toRepoRelative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join(path.posix.sep);
}

/** Resolve one import specifier from `fromFile` to an absolute in-repo file, if possible. */
function resolveImport(root: string, fromFile: string, specifier: string): string | null {
  // Only resolve relative imports in v0; bare specifiers are packages (out of scope)
  // and tsconfig path aliases are a Phase 0 roadmap item.
  if (!specifier.startsWith(".")) return null;
  const resolved = ts.resolveModuleName(specifier, fromFile, { allowJs: true, checkJs: false }, ts.sys);
  const resolvedFile = resolved.resolvedModule?.resolvedFileName;
  if (resolvedFile && !resolvedFile.includes("node_modules") && resolvedFile.startsWith(root)) {
    return resolvedFile;
  }
  // Fallback for plain JS repos where TS resolution declines: try common extensions.
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    ...[...SOURCE_EXTENSIONS].map((ext) => base + ext),
    ...[...SOURCE_EXTENSIONS].map((ext) => path.join(base, "index" + ext)),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Build the file-level import graph for a repo. */
export function buildFileGraph(repoRoot: string): FileGraph {
  const root = path.resolve(repoRoot);
  const files = listSourceFiles(root);
  const imports = new Map<string, Set<string>>();
  const importedBy = new Map<string, Set<string>>();
  const relFiles: string[] = [];

  for (const file of files) {
    const rel = toRepoRelative(root, file);
    relFiles.push(rel);
    if (!imports.has(rel)) imports.set(rel, new Set());

    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const info = ts.preProcessFile(text, true, true);
    for (const ref of info.importedFiles) {
      const target = resolveImport(root, file, ref.fileName);
      if (!target) continue;
      const targetRel = toRepoRelative(root, target);
      imports.get(rel)!.add(targetRel);
      if (!importedBy.has(targetRel)) importedBy.set(targetRel, new Set());
      importedBy.get(targetRel)!.add(rel);
    }
  }
  return { imports, importedBy, files: relFiles.sort() };
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
  return {
    file,
    dependencies: [...(graph.imports.get(file) ?? [])].sort(),
    dependents: [...(graph.importedBy.get(file) ?? [])].sort(),
    transitiveDependents: transitiveDependents(graph, file),
  };
}
