/**
 * The TypeScript/JavaScript LanguageScanner: the original graph builder's parsing and module
 * resolution, moved behind the LanguageScanner seam unchanged. Uses the TypeScript compiler API
 * (preProcessFile + ts.resolveModuleName) so results stay deterministic and config-aware —
 * tsconfig path aliases, monorepo workspaces, symbol-level import edges.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { canonicalPath } from "../util/platform.js";
import { IGNORED_DIRS } from "./shared.js";
import { WHOLE_MODULE, type FileScanResult, type LanguageScanner, type ScannedImport } from "./scanner.js";

export const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

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
    ...[...TS_EXTENSIONS].map((ext) => base + ext),
    ...[...TS_EXTENSIONS].map((ext) => path.join(base, "index" + ext)),
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

/**
 * Realpath (workspace installs symlink into node_modules) and require in-repo, non-vendored.
 * Canonicalized through the same helper as the graph root — the containment check below compares
 * the two, and a root that went through `realpath.native` while this side went through the JS
 * `realpath` would disagree on Windows (8.3 short names, drive-letter case).
 */
function toInRepoSource(root: string, filePath: string): string | null {
  const real = canonicalPath(filePath);
  if (real.includes(`${path.sep}node_modules${path.sep}`)) return null;
  if (!real.startsWith(root + path.sep)) return null;
  return real;
}

/** Resolve one import specifier from `fromFile` to an absolute in-repo file, if possible. */
function resolveImportSpecifier(resolver: Resolver, fromFile: string, specifier: string): string | null {
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

/**
 * Parse a TS/JS file into imports (with per-specifier symbols) and exports. Edges come from
 * preProcessFile (which also catches require/dynamic import); the symbols pulled from each
 * specifier come from the AST walk. A specifier the AST didn't attribute symbols to becomes a
 * side-effect import (empty symbol set), preserving the original builder's behavior exactly.
 */
function scanTypeScript(absFile: string, content: string): FileScanResult {
  const bySpec = new Map<string, Set<string>>();
  const info = ts.preProcessFile(content, true, true);
  for (const ref of info.importedFiles) {
    if (!bySpec.has(ref.fileName)) bySpec.set(ref.fileName, new Set());
  }
  const sourceFile = ts.createSourceFile(absFile, content, ts.ScriptTarget.Latest, false);
  for (const [specifier, symbols] of collectModuleUses(sourceFile)) {
    const set = bySpec.get(specifier);
    if (set) for (const symbol of symbols) set.add(symbol);
  }
  const imports: ScannedImport[] = [...bySpec].map(([specifier, symbols]) => ({ specifier, symbols }));
  return { imports, exports: collectExports(sourceFile) };
}

/** Build the TypeScript/JavaScript scanner for a repo (resolver state built once). */
export function createTypeScriptScanner(root: string): LanguageScanner {
  const resolver = createResolver(path.resolve(root));
  return {
    extensions: TS_EXTENSIONS,
    scanFile: (absFile, content) => scanTypeScript(absFile, content),
    resolveImport: (specifier, fromFile) => resolveImportSpecifier(resolver, fromFile, specifier),
  };
}
