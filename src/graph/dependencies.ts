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
  /**
   * importer -> (imported file -> symbols used). "default" is the default export,
   * "*" means the whole module (namespace object escaping, dynamic import, require).
   * An empty set is a side-effect-only import.
   */
  importSymbols: Map<string, Map<string, Set<string>>>;
  /** file -> its exported names ("default"; "*" when it re-exports everything from another module) */
  exportsOf: Map<string, Set<string>>;
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
  /** names this file exports ("default"; "*" = re-exports everything from another module) */
  exports: string[];
  /** dependency file -> symbols this file imports from it (see FileGraph.importSymbols) */
  importsFrom: Record<string, string[]>;
  /** dependent file -> exports of this file it actually uses */
  usedBy: Record<string, string[]>;
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

const DEFAULT_OPTIONS: ts.CompilerOptions = { allowJs: true, checkJs: false };

/** Per-repo resolution state: tsconfig options and workspace package map, built once. */
interface Resolver {
  root: string;
  /** directory of an importing file -> compiler options of its nearest in-repo tsconfig */
  optionsByDir: Map<string, ts.CompilerOptions>;
  /** tsconfig path -> parsed options (many dirs share one config) */
  optionsByConfig: Map<string, ts.CompilerOptions>;
  /** workspace package name -> absolute package directory */
  workspacePackages: Map<string, string>;
}

function createResolver(root: string): Resolver {
  return {
    root,
    optionsByDir: new Map(),
    optionsByConfig: new Map(),
    workspacePackages: discoverWorkspacePackages(root),
  };
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Compiler options for imports written in files under `dir`, from the nearest tsconfig.
 * Configs outside the repo root are ignored so fixture/target repos never inherit the
 * host machine's configuration.
 */
function compilerOptionsFor(resolver: Resolver, dir: string): ts.CompilerOptions {
  const cached = resolver.optionsByDir.get(dir);
  if (cached) return cached;

  let options = DEFAULT_OPTIONS;
  const configPath = ts.findConfigFile(dir, ts.sys.fileExists, "tsconfig.json");
  if (configPath && path.resolve(configPath).startsWith(resolver.root + path.sep)) {
    const byConfig = resolver.optionsByConfig.get(configPath);
    if (byConfig) {
      options = byConfig;
    } else {
      const read = ts.readConfigFile(configPath, ts.sys.readFile);
      if (!read.error && read.config) {
        const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath));
        parsed.options.allowJs ??= true;
        parsed.options.checkJs = false;
        options = parsed.options;
      }
      resolver.optionsByConfig.set(configPath, options);
    }
  }
  resolver.optionsByDir.set(dir, options);
  return options;
}

/** Map package name -> directory for npm/yarn (`workspaces`) and pnpm workspace repos. */
function discoverWorkspacePackages(root: string): Map<string, string> {
  const patterns: string[] = [];

  const rootPkg = readJson(path.join(root, "package.json"));
  const ws = rootPkg?.workspaces;
  if (Array.isArray(ws)) {
    patterns.push(...ws.filter((p): p is string => typeof p === "string"));
  } else if (typeof ws === "object" && ws !== null && Array.isArray((ws as { packages?: unknown }).packages)) {
    patterns.push(...(ws as { packages: unknown[] }).packages.filter((p): p is string => typeof p === "string"));
  }

  const pnpmPath = path.join(root, "pnpm-workspace.yaml");
  if (fs.existsSync(pnpmPath)) {
    try {
      patterns.push(...parsePnpmWorkspacePatterns(fs.readFileSync(pnpmPath, "utf8")));
    } catch {
      // unreadable workspace file: treat as no pnpm workspaces
    }
  }

  const packages = new Map<string, string>();
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) continue;
    for (const dir of expandWorkspacePattern(root, pattern.split("/").filter(Boolean))) {
      const name = readJson(path.join(dir, "package.json"))?.name;
      if (typeof name === "string" && !packages.has(name)) packages.set(name, dir);
    }
  }
  return packages;
}

/** Minimal parser for the `packages:` list in pnpm-workspace.yaml (no yaml dep). */
function parsePnpmWorkspacePatterns(text: string): string[] {
  const patterns: string[] = [];
  let inPackages = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "");
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const item = /^\s+-\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
    if (item?.[1]) patterns.push(item[1]);
    else if (line.trim() !== "") inPackages = false;
  }
  return patterns;
}

function subdirectories(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name) && !e.name.startsWith("."))
    .map((e) => path.join(dir, e.name));
}

/** Expand a workspace glob (segments) against the filesystem. Supports `*` and `**`. */
function expandWorkspacePattern(dir: string, segments: string[]): string[] {
  if (segments.length === 0) {
    try {
      return fs.statSync(dir).isDirectory() ? [dir] : [];
    } catch {
      return [];
    }
  }
  const segment = segments[0]!;
  const rest = segments.slice(1);
  if (segment === "**") {
    const matches = new Set(expandWorkspacePattern(dir, rest));
    for (const sub of subdirectories(dir)) {
      for (const match of expandWorkspacePattern(sub, segments)) matches.add(match);
    }
    return [...matches];
  }
  if (segment.includes("*")) {
    const regex = new RegExp(
      "^" + segment.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
    );
    return subdirectories(dir)
      .filter((sub) => regex.test(path.basename(sub)))
      .flatMap((sub) => expandWorkspacePattern(sub, rest));
  }
  return expandWorkspacePattern(path.join(dir, segment), rest);
}

/** Try `base` as a file, with source extensions appended, or as a directory with an index. */
function resolveAsFile(base: string): string | null {
  const candidates = [
    base,
    ...[...SOURCE_EXTENSIONS].map((ext) => base + ext),
    ...[...SOURCE_EXTENSIONS].map((ext) => path.join(base, "index" + ext)),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // candidate does not exist
    }
  }
  return null;
}

function isUnderIgnoredDir(baseDir: string, filePath: string): boolean {
  return path
    .relative(baseDir, filePath)
    .split(path.sep)
    .some((segment) => IGNORED_DIRS.has(segment));
}

/** Entry-point candidates for a workspace package, source files preferred over built output. */
function packageEntryCandidates(pkg: Record<string, unknown> | null): string[] {
  const candidates: string[] = [];
  const fromExports = pickExportTarget(pkg?.exports);
  if (fromExports) candidates.push(fromExports);
  for (const field of ["module", "main", "types", "typings"]) {
    const value = pkg?.[field];
    if (typeof value === "string") candidates.push(value);
  }
  candidates.push("src/index", "index");
  return candidates;
}

/** Pull a concrete file target out of a package.json `exports` value ("." entry). */
function pickExportTarget(exp: unknown): string | null {
  if (typeof exp === "string") return exp;
  if (typeof exp !== "object" || exp === null) return null;
  const map = exp as Record<string, unknown>;
  const dot = "." in map ? map["."] : map;
  if (typeof dot === "string") return dot;
  if (typeof dot !== "object" || dot === null) return null;
  for (const condition of ["import", "default", "require", "node", "types"]) {
    const target = pickExportTarget((dot as Record<string, unknown>)[condition]);
    if (target) return target;
  }
  return null;
}

/**
 * Resolve a bare specifier against workspace packages: `@myorg/shared` -> the package's
 * source entry point, `@myorg/shared/src/helpers` -> that file inside the package.
 * Entry candidates that land in built-output dirs (dist, build, ...) are skipped so
 * graph edges point at source files, matching what the scanner indexes.
 */
function resolveWorkspaceImport(resolver: Resolver, specifier: string): string | null {
  let bestName: string | null = null;
  for (const name of resolver.workspacePackages.keys()) {
    if (specifier === name || specifier.startsWith(name + "/")) {
      if (!bestName || name.length > bestName.length) bestName = name;
    }
  }
  if (!bestName) return null;
  const pkgDir = resolver.workspacePackages.get(bestName)!;

  const subpath = specifier.slice(bestName.length + 1);
  if (subpath) return resolveAsFile(path.join(pkgDir, subpath));

  const pkg = readJson(path.join(pkgDir, "package.json"));
  for (const candidate of packageEntryCandidates(pkg)) {
    const resolved = resolveAsFile(path.join(pkgDir, candidate));
    if (resolved && !isUnderIgnoredDir(pkgDir, resolved)) return resolved;
  }
  return null;
}

/** Realpath (workspace installs symlink into node_modules) and require in-repo, non-vendored. */
function toInRepoSource(root: string, filePath: string): string | null {
  let real = filePath;
  try {
    real = fs.realpathSync(filePath);
  } catch {
    // keep the unresolved path; existence was already established by the resolver
  }
  if (real.includes(`${path.sep}node_modules${path.sep}`)) return null;
  if (!real.startsWith(root + path.sep)) return null;
  return real;
}

/** Resolve one import specifier from `fromFile` to an absolute in-repo file, if possible. */
function resolveImport(resolver: Resolver, fromFile: string, specifier: string): string | null {
  const isRelative = specifier.startsWith(".");

  // Cross-package workspace imports resolve through the package map first so they land on
  // source files regardless of whether node_modules is installed or entries point at dist.
  if (!isRelative) {
    const fromWorkspace = resolveWorkspaceImport(resolver, specifier);
    if (fromWorkspace) return fromWorkspace;
  }

  // TS compiler resolution with the importing file's tsconfig: handles relative imports
  // and compilerOptions.paths/baseUrl aliases. Anything landing in node_modules (or
  // outside the repo) is a package, not a graph edge.
  const options = compilerOptionsFor(resolver, path.dirname(fromFile));
  const resolved = ts.resolveModuleName(specifier, fromFile, options, ts.sys);
  const resolvedFile = resolved.resolvedModule?.resolvedFileName;
  if (resolvedFile) {
    const inRepo = toInRepoSource(resolver.root, resolvedFile);
    if (inRepo) return inRepo;
  }

  // Fallback for plain JS repos where TS resolution declines: try common extensions.
  if (isRelative) {
    return resolveAsFile(path.resolve(path.dirname(fromFile), specifier));
  }
  return null;
}

/** Whole-module marker: namespace object escapes, dynamic import, require, export-star. */
const WHOLE_MODULE = "*";

function moduleSpecifierText(node: ts.ImportDeclaration | ts.ExportDeclaration): string | null {
  return node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)
    ? node.moduleSpecifier.text
    : null;
}

/**
 * Which symbols each module specifier contributes to this file, by AST walk.
 * Named imports record the source-side name (`import { a as b }` -> "a"); namespace
 * imports are narrowed to the members actually accessed, falling back to "*" when the
 * namespace object itself escapes (passed around, spread, re-exported).
 */
function collectModuleUses(sourceFile: ts.SourceFile): Map<string, Set<string>> {
  const uses = new Map<string, Set<string>>();
  const forSpecifier = (specifier: string): Set<string> => {
    let set = uses.get(specifier);
    if (!set) {
      set = new Set();
      uses.set(specifier, set);
    }
    return set;
  };
  /** local namespace-import identifier -> its module specifier */
  const namespaces = new Map<string, string>();

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const specifier = moduleSpecifierText(stmt);
      if (specifier === null) continue;
      const symbols = forSpecifier(specifier);
      const clause = stmt.importClause;
      if (clause?.name) symbols.add("default");
      if (clause?.namedBindings) {
        if (ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            symbols.add((element.propertyName ?? element.name).text);
          }
        } else {
          namespaces.set(clause.namedBindings.name.text, specifier);
        }
      }
    } else if (ts.isExportDeclaration(stmt)) {
      const specifier = moduleSpecifierText(stmt);
      if (specifier === null) continue;
      const symbols = forSpecifier(specifier);
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const element of stmt.exportClause.elements) {
          symbols.add((element.propertyName ?? element.name).text);
        }
      } else {
        // `export * from` and `export * as ns from` forward the whole module.
        symbols.add(WHOLE_MODULE);
      }
    } else if (
      ts.isImportEqualsDeclaration(stmt) &&
      ts.isExternalModuleReference(stmt.moduleReference) &&
      ts.isStringLiteralLike(stmt.moduleReference.expression)
    ) {
      forSpecifier(stmt.moduleReference.expression.text).add(WHOLE_MODULE);
    }
  }

  const visit = (node: ts.Node): void => {
    // Import/export-from statements were handled above; their identifiers are not uses.
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) return;
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) return;

    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) forSpecifier(arg.text).add(WHOLE_MODULE);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) forSpecifier(arg.text).add(WHOLE_MODULE);
    } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const specifier = namespaces.get(node.expression.text);
      if (specifier !== undefined) {
        forSpecifier(specifier).add(node.name.text);
        return; // don't descend: the base identifier is attributed, not escaping
      }
    } else if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const specifier = namespaces.get(node.expression.text);
      if (specifier !== undefined) {
        const arg = node.argumentExpression;
        forSpecifier(specifier).add(ts.isStringLiteralLike(arg) ? arg.text : WHOLE_MODULE);
        ts.forEachChild(arg, visit);
        return;
      }
    } else if (ts.isQualifiedName(node) && ts.isIdentifier(node.left)) {
      const specifier = namespaces.get(node.left.text);
      if (specifier !== undefined) {
        forSpecifier(specifier).add(node.right.text);
        return;
      }
    } else if (ts.isIdentifier(node)) {
      // A bare reference to the namespace binding: the whole module escapes.
      const specifier = namespaces.get(node.text);
      if (specifier !== undefined) forSpecifier(specifier).add(WHOLE_MODULE);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  return uses;
}

function bindingNames(name: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(name)) {
    into.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) bindingNames(element.name, into);
  }
}

/** Exported names of a file, from declaration modifiers and export statements. */
function collectExports(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const stmt of sourceFile.statements) {
    if (ts.isExportAssignment(stmt)) {
      names.add("default");
      continue;
    }
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.exportClause) {
        if (ts.isNamedExports(stmt.exportClause)) {
          for (const element of stmt.exportClause.elements) names.add(element.name.text);
        } else {
          names.add(stmt.exportClause.name.text); // export * as ns from "..."
        }
      } else {
        names.add(WHOLE_MODULE); // export * from "..." — contents unknown without resolving
      }
      continue;
    }
    const modifiers = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
    if (!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
      names.add("default");
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) bindingNames(decl.name, names);
    } else if (
      (ts.isFunctionDeclaration(stmt) ||
        ts.isClassDeclaration(stmt) ||
        ts.isInterfaceDeclaration(stmt) ||
        ts.isTypeAliasDeclaration(stmt) ||
        ts.isEnumDeclaration(stmt) ||
        ts.isModuleDeclaration(stmt)) &&
      stmt.name &&
      ts.isIdentifier(stmt.name)
    ) {
      names.add(stmt.name.text);
    }
  }
  return names;
}

/** Build the file-level import graph for a repo. */
/** The per-file outputs the graph is assembled from. Depends only on the file's own
 *  content plus the resolver (tsconfig/workspace layout) and which files exist. */
interface FileScan {
  imports: Set<string>;
  importSymbols: Map<string, Set<string>>;
  exports: Set<string>;
}

/** Scan a single source file's imports, imported symbols, and exports. */
function scanFile(resolver: Resolver, root: string, absFile: string): FileScan | null {
  let text: string;
  try {
    text = fs.readFileSync(absFile, "utf8");
  } catch {
    return null;
  }
  // preProcessFile drives the edges (it also catches require/dynamic imports);
  // resolve each unique specifier once and reuse for symbol attribution below.
  const resolvedBySpecifier = new Map<string, string | null>();
  const resolve = (specifier: string): string | null => {
    if (!resolvedBySpecifier.has(specifier)) {
      resolvedBySpecifier.set(specifier, resolveImport(resolver, absFile, specifier));
    }
    return resolvedBySpecifier.get(specifier)!;
  };

  const imports = new Set<string>();
  const info = ts.preProcessFile(text, true, true);
  for (const ref of info.importedFiles) {
    const target = resolve(ref.fileName);
    if (target) imports.add(toRepoRelative(root, target));
  }

  const sourceFile = ts.createSourceFile(absFile, text, ts.ScriptTarget.Latest, false);
  const importSymbols = new Map<string, Set<string>>();
  for (const [specifier, symbols] of collectModuleUses(sourceFile)) {
    const target = resolve(specifier);
    if (!target) continue;
    const targetRel = toRepoRelative(root, target);
    let set = importSymbols.get(targetRel);
    if (!set) {
      set = new Set();
      importSymbols.set(targetRel, set);
    }
    for (const symbol of symbols) set.add(symbol);
  }

  return { imports, importSymbols, exports: collectExports(sourceFile) };
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

function emptyScan(): FileScan {
  return { imports: new Set(), importSymbols: new Map(), exports: new Set() };
}

export function buildFileGraph(repoRoot: string): FileGraph {
  const root = path.resolve(repoRoot);
  const resolver = createResolver(root);
  const imports = new Map<string, Set<string>>();
  const importSymbols = new Map<string, Map<string, Set<string>>>();
  const exportsOf = new Map<string, Set<string>>();
  const relFiles: string[] = [];

  for (const file of listSourceFiles(root)) {
    const rel = toRepoRelative(root, file);
    relFiles.push(rel);
    const scan = scanFile(resolver, root, file) ?? emptyScan();
    imports.set(rel, scan.imports);
    importSymbols.set(rel, scan.importSymbols);
    exportsOf.set(rel, scan.exports);
  }

  return {
    imports,
    importedBy: invertImports(imports),
    importSymbols,
    exportsOf,
    files: relFiles.sort(),
  };
}

/**
 * Incrementally rebuild a graph after only the *contents* of existing files changed —
 * no files added, removed, or resolver-config changes (the cache layer enforces that).
 * Under those conditions this is provably identical to a full buildFileGraph: an
 * unchanged file's edges depend on its own content, the resolver, and which files exist,
 * none of which moved, so only the modified files need rescanning.
 */
export function updateFileGraph(
  repoRoot: string,
  base: FileGraph,
  modifiedFiles: Iterable<string>,
): FileGraph {
  const root = path.resolve(repoRoot);
  const resolver = createResolver(root);
  const imports = new Map(base.imports);
  const importSymbols = new Map(base.importSymbols);
  const exportsOf = new Map(base.exportsOf);

  for (const rel of modifiedFiles) {
    const scan = scanFile(resolver, root, path.resolve(root, rel)) ?? emptyScan();
    imports.set(rel, scan.imports);
    importSymbols.set(rel, scan.importSymbols);
    exportsOf.set(rel, scan.exports);
  }

  return { imports, importedBy: invertImports(imports), importSymbols, exportsOf, files: base.files };
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

  return {
    file,
    dependencies,
    dependents,
    transitiveDependents: transitiveDependents(graph, file),
    exports: [...(graph.exportsOf.get(file) ?? [])].sort(),
    importsFrom,
    usedBy,
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
  return SOURCE_EXTENSIONS.has(path.posix.extname(relPosixPath));
}

/** On-disk graph format; bump when the serialized shape changes so stale caches are dropped. */
export const GRAPH_FORMAT_VERSION = 1;

export interface SerializedFileGraph {
  version: number;
  files: string[];
  imports: [string, string[]][];
  importSymbols: [string, [string, string[]][]][];
  exportsOf: [string, string[]][];
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
  };
}

/** Rebuild a FileGraph from serialized form, validating shape. Returns null if the data
 *  is malformed or from an incompatible version — the caller then rebuilds from source. */
export function deserializeFileGraph(data: unknown): FileGraph | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Partial<SerializedFileGraph>;
  if (d.version !== GRAPH_FORMAT_VERSION) return null;
  if (!Array.isArray(d.files) || !Array.isArray(d.imports) || !Array.isArray(d.importSymbols) || !Array.isArray(d.exportsOf)) {
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
    return { imports, importedBy: invertImports(imports), importSymbols, exportsOf, files: d.files };
  } catch {
    return null;
  }
}
