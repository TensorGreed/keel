/**
 * Diff -> impacted-subgraph mapping. The scoping engine for the flight simulator: given a
 * change (a unified diff, or the working tree's uncommitted changes), it reports which
 * files are impacted and why. This is pure static analysis over the cached graph — no test
 * execution, no sandbox, no LLM (see CLAUDE.md). Test selection consumes this next.
 *
 * Two views are returned:
 *   - impactedFiles:    file-level transitive dependents (a safe overapproximation)
 *   - impactedNarrowed: symbol-aware — a direct dependent is dropped only when the touched
 *                       declarations provably don't reach any export it uses. When a change
 *                       can't be pinned to specific exports (a helper, an import, a
 *                       module-level line, a removed export), the whole file is treated as
 *                       changed. Beyond the first hop we can't track which symbols carry the
 *                       effect, so an impacted intermediate propagates opaquely.
 *
 * Impact is computed against the HEAD baseline graph, so a deleted file still shows the
 * dependents it had before deletion.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import ts from "typescript";
import { isGraphSourcePath, type FileGraph } from "../graph/dependencies.js";
import { gitShowHead, loadHeadGraph } from "../graph/cache.js";

const execFileAsync = promisify(execFile);

export type ChangeStatus = "modified" | "added" | "deleted" | "renamed";

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  oldPath?: string;
  /** whether this is a source file the graph tracks (false for docs, JSON, etc.) */
  inGraph: boolean;
}

export interface NarrowedImpact {
  file: string;
  /** the changed file(s) and symbols that caused this file to be included */
  causedBy: { changedFile: string; symbols: string[] }[];
}

export interface ImpactResult {
  changedFiles: ChangedFile[];
  /** propagating changed file -> exported symbols it touched ("*" = all exports assumed changed) */
  changedSymbols: Record<string, string[]>;
  /** file-level blast radius (safe overapproximation), sorted */
  impactedFiles: string[];
  /** symbol-aware subset of impactedFiles, with the symbols that caused inclusion */
  impactedNarrowed: NarrowedImpact[];
  /** impacted file -> shortest dependency path to a changed file: [impacted, ..., changed] */
  paths: Record<string, string[]>;
}

// --- diff parsing -----------------------------------------------------------

interface Hunk {
  oldStart: number;
  newStart: number;
  body: string[]; // lines beginning with ' ', '+', '-', or '\'
}

interface FileDiff {
  oldPath: string | null;
  newPath: string | null;
  status: ChangeStatus;
  hunks: Hunk[];
}

class DiffParseError extends Error {}

function stripPrefix(raw: string): string | null {
  const p = raw.trim();
  if (p === "/dev/null") return null;
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

/** Parse a unified (git) diff into per-file changes with hunk line ranges. */
function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = text.split("\n");
  let cur: {
    minus: string | null;
    plus: string | null;
    renameFrom: string | null;
    renameTo: string | null;
    isNew: boolean;
    isDeleted: boolean;
    hunks: Hunk[];
    hunk: Hunk | null;
  } | null = null;

  const finish = (): void => {
    if (!cur) return;
    let status: ChangeStatus;
    let oldPath: string | null;
    let newPath: string | null;
    if (cur.renameFrom !== null || cur.renameTo !== null) {
      status = "renamed";
      oldPath = cur.renameFrom;
      newPath = cur.renameTo;
    } else if (cur.isNew || cur.minus === null) {
      status = "added";
      oldPath = null;
      newPath = cur.plus;
    } else if (cur.isDeleted || cur.plus === null) {
      status = "deleted";
      oldPath = cur.minus;
      newPath = null;
    } else {
      status = "modified";
      oldPath = cur.minus;
      newPath = cur.plus;
    }
    if (cur.hunk) cur.hunks.push(cur.hunk);
    // Ignore pure mode/index changes that name no path at all.
    if (oldPath !== null || newPath !== null) {
      files.push({ oldPath, newPath, status, hunks: cur.hunks });
    }
    cur = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      finish();
      cur = { minus: null, plus: null, renameFrom: null, renameTo: null, isNew: false, isDeleted: false, hunks: [], hunk: null };
      continue;
    }
    if (!cur) continue; // preamble before the first file header

    if (line.startsWith("new file mode")) cur.isNew = true;
    else if (line.startsWith("deleted file mode")) cur.isDeleted = true;
    else if (line.startsWith("rename from ")) cur.renameFrom = stripPrefix(line.slice("rename from ".length));
    else if (line.startsWith("rename to ")) cur.renameTo = stripPrefix(line.slice("rename to ".length));
    else if (line.startsWith("--- ")) cur.minus = stripPrefix(line.slice(4));
    else if (line.startsWith("+++ ")) cur.plus = stripPrefix(line.slice(4));
    else if (line.startsWith("@@")) {
      if (cur.hunk) cur.hunks.push(cur.hunk);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!m) throw new DiffParseError(`malformed hunk header: ${line}`);
      cur.hunk = { oldStart: Number(m[1]), newStart: Number(m[2]), body: [] };
    } else if (cur.hunk && (line[0] === " " || line[0] === "+" || line[0] === "-" || line[0] === "\\")) {
      cur.hunk.body.push(line);
    }
  }
  finish();
  return files;
}

/** New-file line numbers actually touched by the hunks (added lines, and the position of
 *  each deletion). Context lines are not touched. */
function touchedNewLines(hunks: Hunk[]): Set<number> {
  const touched = new Set<number>();
  for (const hunk of hunks) {
    let line = hunk.newStart;
    for (const entry of hunk.body) {
      const tag = entry[0];
      if (tag === " ") line++;
      else if (tag === "+") touched.add(line++);
      else if (tag === "-") touched.add(line); // deletion sits at this new-file position
    }
  }
  return touched;
}

/** Reconstruct new file content by applying hunks to the baseline text. */
function applyHunks(baseText: string, hunks: Hunk[]): string {
  const baseLines = baseText === "" ? [] : baseText.split("\n");
  const out: string[] = [];
  let cursor = 0; // 0-based index of the next baseline line to copy
  for (const hunk of hunks) {
    const start = hunk.oldStart - 1;
    while (cursor < start && cursor < baseLines.length) out.push(baseLines[cursor++]!);
    for (const entry of hunk.body) {
      const tag = entry[0];
      const content = entry.slice(1);
      if (tag === " ") {
        out.push(content);
        cursor++;
      } else if (tag === "-") {
        cursor++;
      } else if (tag === "+") {
        out.push(content);
      }
    }
  }
  while (cursor < baseLines.length) out.push(baseLines[cursor++]!);
  return out.join("\n");
}

// --- changed-symbol detection -----------------------------------------------

type ChangedExports = { all: true } | { all: false; names: Set<string> };

interface Decl {
  startLine: number; // 1-based
  endLine: number;
  /** local names this statement introduces into module scope (for resolving references) */
  defines: string[];
  /** export names this statement produces (empty for a non-exported helper) */
  exports: string[];
  /** top-level names referenced in this statement's body (identifier walk, over-approx) */
  refs: Set<string>;
  /** touching this can't be localized to specific exports -> treat the file as all-changed
   *  (module-level side-effect code, an import, or anything we can't model) */
  opaque: boolean;
}

/** Exported names a single top-level statement produces, or null if it is not a self-
 *  contained export declaration (so a change to it can't be localized to named exports). */
function statementExportNames(stmt: ts.Statement): string[] | null {
  if (ts.isExportAssignment(stmt)) return ["default"];
  if (ts.isExportDeclaration(stmt)) {
    if (!stmt.exportClause) return ["*"]; // export * from "..."
    if (ts.isNamedExports(stmt.exportClause)) return stmt.exportClause.elements.map((e) => e.name.text);
    return [stmt.exportClause.name.text]; // export * as ns from "..."
  }
  const modifiers = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
  if (!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return null;
  if (modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) return ["default"];
  if (ts.isVariableStatement(stmt)) {
    const names: string[] = [];
    for (const decl of stmt.declarationList.declarations) collectBindingNames(decl.name, names);
    return names;
  }
  if (
    (ts.isFunctionDeclaration(stmt) ||
      ts.isClassDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt) ||
      ts.isModuleDeclaration(stmt)) &&
    stmt.name &&
    ts.isIdentifier(stmt.name)
  ) {
    return [stmt.name.text];
  }
  return null;
}

function collectBindingNames(name: ts.BindingName, into: string[]): void {
  if (ts.isIdentifier(name)) {
    into.push(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) collectBindingNames(element.name, into);
  }
}

/** Local names a statement introduces into module scope, regardless of export. */
function definedNames(stmt: ts.Statement): string[] {
  if (ts.isVariableStatement(stmt)) {
    const names: string[] = [];
    for (const decl of stmt.declarationList.declarations) collectBindingNames(decl.name, names);
    return names;
  }
  if (
    (ts.isFunctionDeclaration(stmt) ||
      ts.isClassDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt) ||
      ts.isModuleDeclaration(stmt)) &&
    stmt.name &&
    ts.isIdentifier(stmt.name)
  ) {
    return [stmt.name.text];
  }
  return [];
}

/**
 * Identifiers referenced in a node's body. Over-approximates on purpose (per the shadowing
 * rule: if unsure whether an identifier is a top-level reference, assume it is) — but skips
 * clear member/property names, which are never top-level bindings.
 */
function collectReferencedIdentifiers(node: ts.Node): Set<string> {
  const refs = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n)) {
      visit(n.expression); // `a.foo` -> `a` is a ref, `foo` is a member
      return;
    }
    if (ts.isQualifiedName(n)) {
      visit(n.left);
      return;
    }
    if (ts.isPropertyAssignment(n)) {
      if (ts.isComputedPropertyName(n.name)) visit(n.name.expression);
      visit(n.initializer);
      return;
    }
    if (ts.isBindingElement(n) && n.propertyName && !ts.isComputedPropertyName(n.propertyName)) {
      visit(n.name); // `const { a: b } = x` -> skip key `a`, keep binding `b`
      if (n.initializer) visit(n.initializer);
      return;
    }
    if (isNamedMember(n)) {
      // An interface/class/enum member name is never a top-level reference; skip it but
      // still visit its type, initializer, parameters, and body (which may hold refs).
      if (n.name && ts.isComputedPropertyName(n.name)) visit(n.name.expression);
      ts.forEachChild(n, (child) => {
        if (child !== n.name) visit(child);
      });
      return;
    }
    if (ts.isIdentifier(n)) {
      refs.add(n.text);
      return;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return refs;
}

type NamedMember = ts.NamedDeclaration & { name?: ts.Node };

function isNamedMember(n: ts.Node): n is NamedMember {
  return (
    ts.isPropertySignature(n) ||
    ts.isMethodSignature(n) ||
    ts.isPropertyDeclaration(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n) ||
    ts.isEnumMember(n)
  );
}

/** Classify every top-level statement of the new content into a Decl. */
function classifyDecls(newContent: string): Decl[] {
  const sf = ts.createSourceFile("change.ts", newContent, ts.ScriptTarget.Latest, true);
  return sf.statements.map((stmt) => {
    const startLine = sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1;
    const endLine = sf.getLineAndCharacterOfPosition(stmt.getEnd()).line + 1;
    const base = { startLine, endLine };

    if (ts.isImportDeclaration(stmt) || ts.isImportEqualsDeclaration(stmt)) {
      // Import changes can reorder/side-effect; keep them opaque as before.
      return { ...base, defines: [], exports: [], refs: new Set<string>(), opaque: true };
    }
    if (ts.isExportDeclaration(stmt)) {
      // `export { local }` references the local; `export { x } from "..."` references nothing here.
      const refs = stmt.moduleSpecifier ? new Set<string>() : collectReferencedIdentifiers(stmt);
      return { ...base, defines: [], exports: statementExportNames(stmt) ?? ["*"], refs, opaque: false };
    }
    if (ts.isExportAssignment(stmt)) {
      return { ...base, defines: [], exports: ["default"], refs: collectReferencedIdentifiers(stmt), opaque: false };
    }
    const defines = definedNames(stmt);
    if (defines.length > 0) {
      return {
        ...base,
        defines,
        exports: statementExportNames(stmt) ?? [], // [] for a non-exported helper
        refs: collectReferencedIdentifiers(stmt),
        opaque: false,
      };
    }
    // A top-level statement that declares nothing (bare expression, side-effect code).
    return { ...base, defines: [], exports: [], refs: collectReferencedIdentifiers(stmt), opaque: true };
  });
}

/**
 * Which exports of a modified file are (potentially) changed, from its new content and the
 * touched new-file lines. Beyond the touched declarations' own exports, expands to every
 * export whose declaration transitively references a touched one — so a change to an
 * internal helper (or to one export used by another) reaches the exports that depend on it.
 * Strictly more precise than reporting only the touched declarations, never less safe:
 * falls back to { all: true } for module-level/import touches or if analysis fails. Removed
 * exports (present at baseline, gone now) are always included.
 */
function changedExportsOf(
  newContent: string,
  touched: Set<number>,
  baselineExports: Set<string>,
): ChangedExports {
  let decls: Decl[];
  try {
    decls = classifyDecls(newContent);
  } catch {
    return { all: true };
  }

  const touchedDecls: number[] = [];
  for (const line of touched) {
    const idx = decls.findIndex((d) => line >= d.startLine && line <= d.endLine);
    if (idx === -1) return { all: true }; // module-level / between declarations
    if (decls[idx]!.opaque) return { all: true }; // import / unmodelable
    if (!touchedDecls.includes(idx)) touchedDecls.push(idx);
  }

  // name -> declarations defining it; then reverse edges: declaration -> its referrers.
  const definers = new Map<string, number[]>();
  decls.forEach((decl, i) => {
    for (const name of decl.defines) {
      const arr = definers.get(name);
      if (arr) arr.push(i);
      else definers.set(name, [i]);
    }
  });
  const referrers = new Map<number, number[]>();
  decls.forEach((decl, i) => {
    for (const name of decl.refs) {
      for (const j of definers.get(name) ?? []) {
        if (j === i) continue;
        const arr = referrers.get(j);
        if (arr) arr.push(i);
        else referrers.set(j, [i]);
      }
    }
  });

  // Intra-file closure: propagate from touched declarations to everything referencing them.
  const affected = new Set<number>(touchedDecls);
  const queue = [...touchedDecls];
  for (let k = 0; k < queue.length; k++) {
    for (const referrer of referrers.get(queue[k]!) ?? []) {
      if (!affected.has(referrer)) {
        affected.add(referrer);
        queue.push(referrer);
      }
    }
  }

  const names = new Set<string>();
  const newExports = new Set<string>();
  for (const decl of decls) for (const name of decl.exports) newExports.add(name);
  for (const i of affected) for (const name of decls[i]!.exports) names.add(name);
  for (const name of baselineExports) if (!newExports.has(name)) names.add(name);
  return { all: false, names };
}

// --- graph propagation ------------------------------------------------------

/** Multi-source BFS over dependents; returns the impacted set and each node's shortest
 *  dependency path back to a changed source: [impacted, ..., changed]. */
function fileLevelImpact(
  graph: FileGraph,
  sources: Set<string>,
): { impacted: string[]; paths: Map<string, string[]> } {
  const pred = new Map<string, string | null>();
  const queue: string[] = [];
  for (const s of sources) {
    pred.set(s, null);
    queue.push(s);
  }
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i]!;
    for (const dependent of graph.importedBy.get(cur) ?? []) {
      if (!pred.has(dependent)) {
        pred.set(dependent, cur);
        queue.push(dependent);
      }
    }
  }
  const impacted: string[] = [];
  const paths = new Map<string, string[]>();
  for (const node of pred.keys()) {
    if (sources.has(node)) continue;
    impacted.push(node);
    const chain: string[] = [];
    let c: string | null | undefined = node;
    while (c != null) {
      chain.push(c);
      c = pred.get(c);
    }
    paths.set(node, chain);
  }
  impacted.sort();
  return { impacted, paths };
}

/** Whether `dependent` is impacted by a change to `source` given the changed exports, and
 *  the symbols that caused it. null when the dependent provably isn't impacted. */
function usageCause(
  graph: FileGraph,
  dependent: string,
  source: string,
  changed: ChangedExports,
): string[] | null {
  const usage = graph.importSymbols.get(dependent)?.get(source) ?? new Set<string>();
  if (usage.size === 0) return ["(side-effect import)"]; // runs the module for effects
  if (usage.has("*")) return ["*"]; // whole module escapes -> any change matters
  if (usage.has("default")) return ["default"]; // conservative per convention
  if (changed.all) return [...usage].sort();
  const intersect = [...usage].filter((u) => changed.names.has(u)).sort();
  return intersect.length > 0 ? intersect : null;
}

function narrowedImpact(
  graph: FileGraph,
  changed: Map<string, ChangedExports>,
): NarrowedImpact[] {
  const changedNodes = new Set(changed.keys());
  const reasons = new Map<string, Map<string, Set<string>>>(); // file -> changedFile -> symbols
  const opaqueQueue: string[] = [];

  const record = (file: string, via: string, symbols: string[]): boolean => {
    let byChanged = reasons.get(file);
    const first = byChanged === undefined;
    if (!byChanged) {
      byChanged = new Map();
      reasons.set(file, byChanged);
    }
    let set = byChanged.get(via);
    if (!set) {
      set = new Set();
      byChanged.set(via, set);
    }
    for (const s of symbols) set.add(s);
    return first;
  };

  // First hop: precise symbol gating from each changed file to its direct dependents.
  for (const [source, exps] of changed) {
    for (const dependent of graph.importedBy.get(source) ?? []) {
      if (changedNodes.has(dependent)) continue;
      const cause = usageCause(graph, dependent, source, exps);
      if (cause && record(dependent, source, cause)) opaqueQueue.push(dependent);
    }
  }

  // Beyond the first hop we can't localize which exports carry the effect, so an impacted
  // file propagates opaquely: every dependent of it that uses anything is impacted.
  for (let i = 0; i < opaqueQueue.length; i++) {
    const node = opaqueQueue[i]!;
    for (const dependent of graph.importedBy.get(node) ?? []) {
      if (changedNodes.has(dependent)) continue;
      const usage = graph.importSymbols.get(dependent)?.get(node) ?? new Set<string>();
      const symbols = usage.size === 0 ? ["(side-effect import)"] : usage.has("*") ? ["*"] : [...usage].sort();
      if (record(dependent, node, symbols)) opaqueQueue.push(dependent);
    }
  }

  return [...reasons.keys()].sort().map((file) => ({
    file,
    causedBy: [...reasons.get(file)!.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([changedFile, symbols]) => ({ changedFile, symbols: [...symbols].sort() })),
  }));
}

// --- orchestration ----------------------------------------------------------

async function workingTreeDiff(repoRoot: string): Promise<FileDiff[]> {
  const tracked = await git(repoRoot, ["diff", "-M", "HEAD"]);
  const diffs = tracked ? parseUnifiedDiff(tracked) : [];

  // git diff HEAD omits untracked files; add untracked *source* files as new files (a new
  // .md or keel's own .keel/ cache isn't a graph change).
  const untracked = await git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (untracked) {
    for (const p of untracked.split("\0")) {
      if (p && isGraphSourcePath(p)) diffs.push({ oldPath: null, newPath: p, status: "added", hunks: [] });
    }
  }
  return diffs;
}

async function git(repoRoot: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch {
    return null;
  }
}

/** The propagating baseline node for a changed file, plus the exports it changed. Returns
 *  null when the change doesn't propagate (a new file, or a non-source file). */
async function analyzeChange(
  repoRoot: string,
  graph: FileGraph,
  fileDiff: FileDiff,
  fromDiffString: boolean,
): Promise<{ node: string | null; exports: ChangedExports }> {
  const opaque: ChangedExports = { all: true };
  switch (fileDiff.status) {
    case "deleted":
    case "renamed":
      // Consumers of the old path break -> all its exports are effectively changed.
      return { node: fileDiff.oldPath, exports: opaque };
    case "added":
      return { node: null, exports: opaque }; // nothing in the baseline depends on it yet
    case "modified": {
      const p = fileDiff.newPath!;
      if (!isGraphSourcePath(p)) return { node: null, exports: opaque };
      const newContent = fromDiffString
        ? applyHunks((await gitShowHead(repoRoot, fileDiff.oldPath ?? p)) ?? readFileOr(repoRoot, p), fileDiff.hunks)
        : readFileOr(repoRoot, p);
      const baselineExports = graph.exportsOf.get(p) ?? new Set<string>();
      return { node: p, exports: changedExportsOf(newContent, touchedNewLines(fileDiff.hunks), baselineExports) };
    }
  }
}

function readFileOr(repoRoot: string, relPosixPath: string): string {
  try {
    return fs.readFileSync(path.join(repoRoot, relPosixPath), "utf8");
  } catch {
    return "";
  }
}

export async function getImpact(
  repoRoot: string,
  options: { diff?: string } = {},
): Promise<ImpactResult | { error: string }> {
  let fileDiffs: FileDiff[];
  const fromDiffString = options.diff !== undefined;
  try {
    if (fromDiffString) {
      fileDiffs = parseUnifiedDiff(options.diff!);
    } else {
      const { head } = await loadHeadGraph(repoRoot);
      if (head === null) return { error: "no git HEAD to diff the working tree against" };
      fileDiffs = await workingTreeDiff(repoRoot);
    }
  } catch (err) {
    if (err instanceof DiffParseError) return { error: `malformed diff: ${err.message}` };
    throw err;
  }

  const { graph } = await loadHeadGraph(repoRoot);

  const changedFiles: ChangedFile[] = [];
  const changedSymbols: Record<string, string[]> = {};
  const changed = new Map<string, ChangedExports>();

  for (const fileDiff of fileDiffs) {
    const primary = fileDiff.newPath ?? fileDiff.oldPath!;
    const record: ChangedFile = { path: primary, status: fileDiff.status, inGraph: isGraphSourcePath(primary) };
    if (fileDiff.status === "renamed" && fileDiff.oldPath) record.oldPath = fileDiff.oldPath;
    changedFiles.push(record);

    const { node, exports } = await analyzeChange(repoRoot, graph, fileDiff, fromDiffString);
    changedSymbols[primary] = exports.all ? ["*"] : [...exports.names].sort();
    if (node !== null && graph.imports.has(node)) {
      // Merge if two diff entries target the same baseline node.
      const existing = changed.get(node);
      changed.set(node, mergeChangedExports(existing, exports));
    }
  }

  const { impacted, paths } = fileLevelImpact(graph, new Set(changed.keys()));
  const impactedNarrowed = narrowedImpact(graph, changed);

  return {
    changedFiles,
    changedSymbols,
    impactedFiles: impacted,
    impactedNarrowed,
    paths: Object.fromEntries(paths),
  };
}

function mergeChangedExports(a: ChangedExports | undefined, b: ChangedExports): ChangedExports {
  if (!a) return b;
  if (a.all || b.all) return { all: true };
  return { all: false, names: new Set([...a.names, ...b.names]) };
}
