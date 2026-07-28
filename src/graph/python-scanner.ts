/**
 * The Python LanguageScanner, built on web-tree-sitter (WASM) — explicitly NOT the native
 * tree-sitter bindings, so `npm install` never compiles anything. The tree-sitter-python grammar
 * ships as a .wasm asset next to this module (copied into dist/ at build, included in the npm
 * files), keeping installs zero-build.
 *
 * Parses the import forms that matter for a file graph — `import a.b`, `from a.b import c as d`,
 * `from . import x` / `from ..pkg import y` (relative levels), and `from x import *` (→ "*") —
 * and resolves them to in-repo files (regular packages with __init__.py, plain modules, src/
 * layouts, and namespace packages last). Exports are top-level def/class/assignments, or the
 * literal contents of __all__ when it's a list ("*"-opaque otherwise). Deterministic; no model
 * calls. Symbol semantics match the shared model: names, "default" (unused in Python), "*".
 *
 * web-tree-sitter needs a one-time async init (Parser.init + grammar load); the parse itself is
 * synchronous. Callers must `await initPythonScanner()` before building a graph that may contain
 * Python — the graph cache does this on the load path.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser, type Node } from "web-tree-sitter";
import { IGNORED_DIRS } from "./shared.js";
import { WHOLE_MODULE, type FileScanResult, type LanguageScanner, type ScannedImport } from "./scanner.js";

export const PYTHON_EXTENSIONS = new Set([".py", ".pyi"]);

let runtime: { parser: Parser } | null = null;
let initPromise: Promise<void> | null = null;

/** One-time async init: load the WASM runtime and the Python grammar. Idempotent + concurrency-safe. */
export function initPythonScanner(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      await Parser.init();
      const wasmPath = fileURLToPath(new URL("./wasm/tree-sitter-python.wasm", import.meta.url));
      const language = await Language.load(fs.readFileSync(wasmPath));
      const parser = new Parser();
      parser.setLanguage(language);
      runtime = { parser };
    })();
  }
  return initPromise;
}

// --- parsing ---------------------------------------------------------------

/** All import statements anywhere in the tree (top-level, conditional, try/except). */
function forEachImport(node: Node, visit: (n: Node) => void): void {
  if (node.type === "import_statement" || node.type === "import_from_statement") {
    visit(node);
    return; // imports don't nest imports
  }
  for (const child of node.namedChildren) if (child) forEachImport(child, visit);
}

/** The dotted module of an `import`-clause name node (dotted_name or aliased_import). */
function importedModule(nameNode: Node): string | null {
  if (nameNode.type === "dotted_name") return nameNode.text;
  if (nameNode.type === "aliased_import") return nameNode.childForFieldName("name")?.text ?? null;
  return null;
}

/** Parse a `from` clause's module reference into a relative level and dotted module path. */
function fromModule(node: Node): { level: number; module: string } {
  const mod = node.childForFieldName("module_name");
  if (!mod) return { level: 0, module: "" };
  if (mod.type === "relative_import") {
    let level = 0;
    let module = "";
    for (const child of mod.namedChildren) {
      if (!child) continue;
      if (child.type === "import_prefix") level = child.text.length; // ".", "..", ...
      else if (child.type === "dotted_name") module = child.text;
    }
    return { level, module };
  }
  return { level: 0, module: mod.text };
}

/** The source-side names a `from ... import ...` pulls in (empty names + wildcard=true for `*`). */
function fromNames(node: Node): { wildcard: boolean; names: string[] } {
  const names: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === "wildcard_import") return { wildcard: true, names: [] };
    if (node.fieldNameForChild(i) !== "name") continue;
    if (child.type === "dotted_name") names.push(child.text);
    else if (child.type === "aliased_import") {
      const src = child.childForFieldName("name")?.text;
      if (src) names.push(src);
    }
  }
  return { wildcard: false, names };
}

/** A submodule specifier under a base module spec (e.g. base ".pkg" + "x" -> ".pkg.x"). */
function submoduleSpec(baseSpec: string, name: string): string {
  return /^\.*$/.test(baseSpec) ? baseSpec + name : baseSpec + "." + name;
}

/** The literal value of a string node (its content, quotes stripped). */
function stringValue(node: Node): string {
  for (const child of node.namedChildren) if (child?.type === "string_content") return child.text;
  return node.text.replace(/^[a-zA-Z]*['"]{1,3}/, "").replace(/['"]{1,3}$/, "");
}

/** Top-level exported names: def/class/assignment targets, or __all__'s literal contents. */
function collectExports(root: Node): Set<string> {
  const defined = new Set<string>();
  let allValue: Node | null = null;
  let hasAll = false;

  const addDefName = (def: Node | null): void => {
    const name = def?.childForFieldName("name");
    if (name) defined.add(name.text);
  };

  for (const stmt of root.namedChildren) {
    if (!stmt) continue;
    if (stmt.type === "function_definition" || stmt.type === "class_definition") {
      addDefName(stmt);
    } else if (stmt.type === "decorated_definition") {
      addDefName(stmt.childForFieldName("definition"));
    } else if (stmt.type === "expression_statement") {
      const assign = stmt.namedChild(0);
      if (assign?.type !== "assignment") continue;
      const left = assign.childForFieldName("left");
      if (!left) continue;
      if (left.type === "identifier") {
        if (left.text === "__all__") {
          hasAll = true;
          allValue = assign.childForFieldName("right");
        } else {
          defined.add(left.text);
        }
      } else if (left.type === "pattern_list" || left.type === "tuple_pattern") {
        for (const el of left.namedChildren) if (el?.type === "identifier") defined.add(el.text);
      }
    }
  }

  if (hasAll) {
    if (allValue && (allValue.type === "list" || allValue.type === "tuple")) {
      const names = new Set<string>();
      for (const el of allValue.namedChildren) if (el?.type === "string") names.add(stringValue(el));
      return names; // explicit public API
    }
    return new Set([WHOLE_MODULE]); // computed __all__ — contents opaque
  }
  return defined;
}

function scanPython(_absFile: string, content: string): FileScanResult {
  if (!runtime) throw new Error("python scanner not initialized — await initPythonScanner() first");
  const tree = runtime.parser.parse(content);
  const root = tree?.rootNode;
  if (!root) return { imports: [], exports: new Set() };

  const bySpec = new Map<string, Set<string>>();
  const add = (spec: string, symbols: Iterable<string>): void => {
    let set = bySpec.get(spec);
    if (!set) {
      set = new Set();
      bySpec.set(spec, set);
    }
    for (const s of symbols) set.add(s);
  };

  forEachImport(root, (node) => {
    if (node.type === "import_statement") {
      for (const child of node.namedChildren) {
        if (!child) continue;
        const mod = importedModule(child);
        if (mod) add(mod, [WHOLE_MODULE]); // `import a.b` pulls the whole module
      }
      return;
    }
    // import_from_statement
    const { level, module } = fromModule(node);
    const { wildcard, names } = fromNames(node);
    const base = ".".repeat(level) + module; // "", ".", "..", "a.b", ".pkg", "..a.b"
    add(base, wildcard ? [WHOLE_MODULE] : names);
    if (!wildcard) {
      // Each imported name might be a submodule of `base`; emit a candidate edge (dropped if it
      // doesn't resolve to a file). Covers `from pkg import submod` and `from . import x`.
      for (const name of names) add(submoduleSpec(base, name), [WHOLE_MODULE]);
    }
  });

  const imports: ScannedImport[] = [...bySpec].map(([specifier, symbols]) => ({ specifier, symbols }));
  return { imports, exports: collectExports(root) };
}

// --- module resolution -----------------------------------------------------

interface PySpec {
  level: number; // 0 = absolute; N = relative dots
  parts: string[]; // dotted module path
}

function parseSpec(spec: string): PySpec {
  let i = 0;
  while (spec[i] === ".") i++;
  const rest = spec.slice(i);
  return { level: i, parts: rest ? rest.split(".").filter(Boolean) : [] };
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve a dotted module path under a base directory to a file. Intermediate parts must be
 * packages (regular __init__.py, or a namespace directory as a last resort); the final part is a
 * plain module (x.py) or a package (x/__init__.py). A namespace package (a directory with no
 * __init__.py) has no file, so a bare reference to one yields null (its *modules* still resolve).
 */
function resolveModulePath(baseDir: string, parts: string[]): string | null {
  if (parts.length === 0) {
    const init = path.join(baseDir, "__init__.py");
    return isFile(init) ? init : null; // the package itself (namespace dir -> no file)
  }
  let dir = baseDir;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (isFile(path.join(dir, part, "__init__.py"))) dir = path.join(dir, part); // regular package
    else if (isDir(path.join(dir, part))) dir = path.join(dir, part); // namespace package (last resort)
    else return null;
  }
  const last = parts[parts.length - 1]!;
  const asModule = path.join(dir, last + ".py");
  if (isFile(asModule)) return asModule;
  const asPackage = path.join(dir, last, "__init__.py");
  if (isFile(asPackage)) return asPackage;
  return null; // plain module / regular package not found (namespace package has no file)
}

/** Extra module roots for a src/ layout, when pyproject.toml or setup.cfg declares one. */
function detectRoots(repoRoot: string): string[] {
  const roots = [repoRoot];
  const srcDir = path.join(repoRoot, "src");
  if (isDir(srcDir) && declaresSrcLayout(repoRoot)) roots.push(srcDir);
  return roots;
}

/** Minimal, dependency-free check for a package-dir/where = "src" declaration. */
function declaresSrcLayout(repoRoot: string): boolean {
  for (const cfg of ["pyproject.toml", "setup.cfg"]) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(repoRoot, cfg), "utf8");
    } catch {
      continue;
    }
    // e.g. `package-dir = {"" = "src"}`, `package_dir = =src`, `where = src`, `packages = ["src/..."]`
    if (/(package[-_]dir|where)\s*=\s*[^#\n]*\bsrc\b/.test(text) || /\bpackages\b\s*=\s*[^#\n]*["']src\//.test(text)) {
      return true;
    }
  }
  return false;
}

/** In-repo and not inside an ignored/virtualenv dir. */
function inRepoSource(repoRoot: string, file: string): boolean {
  if (!file.startsWith(repoRoot + path.sep)) return false;
  return !path
    .relative(repoRoot, file)
    .split(path.sep)
    .some((seg) => IGNORED_DIRS.has(seg));
}

function resolvePythonImport(repoRoot: string, roots: string[], specifier: string, fromFile: string): string | null {
  const { level, parts } = parseSpec(specifier);

  if (level === 0) {
    for (const root of roots) {
      const file = resolveModulePath(root, parts);
      if (file && inRepoSource(repoRoot, file)) return file;
    }
    return null; // absolute import of a stdlib/third-party package — no in-repo edge
  }

  // Relative: start at the file's package dir, then climb (level - 1) more.
  let base = path.dirname(fromFile);
  for (let i = 1; i < level; i++) base = path.dirname(base);
  const file = resolveModulePath(base, parts);
  return file && inRepoSource(repoRoot, file) ? file : null;
}

/** Build the Python scanner for a repo (roots computed once). Requires initPythonScanner(). */
export function createPythonScanner(root: string): LanguageScanner {
  const repoRoot = path.resolve(root);
  const roots = detectRoots(repoRoot);
  return {
    extensions: PYTHON_EXTENSIONS,
    scanFile: (absFile, content) => scanPython(absFile, content),
    resolveImport: (specifier, fromFile) => resolvePythonImport(repoRoot, roots, specifier, fromFile),
  };
}
