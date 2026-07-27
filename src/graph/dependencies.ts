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

/** Build the file-level import graph for a repo. */
export function buildFileGraph(repoRoot: string): FileGraph {
  const root = path.resolve(repoRoot);
  const resolver = createResolver(root);
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
      const target = resolveImport(resolver, file, ref.fileName);
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
