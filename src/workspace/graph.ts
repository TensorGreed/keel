/**
 * The workspace graph — one dependency graph spanning several repos. It loads each member repo's
 * own file graph (unchanged, cached per repo), namespaces every file as `name::relpath`, and then
 * adds the cross-repo edges: a member's *external* import (one that didn't resolve inside its own
 * repo) is matched against what a sibling repo publishes.
 *
 * How a sibling "publishes" differs by language, and keel resolves each deterministically:
 *   - TS/JS: by package.json `name` → the package's source entry (JS resolution is name-based, so a
 *     sibling's own resolver can't see it — we read the manifest). Subpaths (`name/x`) resolve under
 *     the package dir.
 *   - Python / Go: by REUSING the sibling repo's own resolver. An absolute import (`shared.mod`, a Go
 *     import path) resolves against that repo's roots/modules exactly as an in-repo import would, so
 *     the sibling's scanner already answers "do I provide this?" — no separate manifest needed.
 * Java (published jars → artifact coordinates) is out of scope for this pass.
 *
 * Cross-repo edges are routed by the importing file's language, so a TS specifier never matches a
 * Python publisher. Deterministic static analysis, no model calls. Execution, decisions, and the MCP
 * tools remain single-repo for now (see docs/architecture.md) — this is the graph/impact layer.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadGraph } from "../graph/cache.js";
import type { FileGraph } from "../graph/dependencies.js";
import type { LanguageScanner } from "../graph/scanner.js";
import { createScanners } from "../graph/scanners.js";
import type { WorkspaceConfig, WorkspaceMember } from "./config.js";
import { versionSkewWarnings } from "./skew.js";

const SEP = "::";
/** A workspace-qualified file key: `<member name>::<repo-relative path>`. */
export const qualify = (name: string, rel: string): string => `${name}${SEP}${rel}`;
export const memberOf = (qualified: string): string => qualified.slice(0, qualified.indexOf(SEP));

export interface CrossEdge {
  from: string;
  to: string;
  /** the import specifier that crossed the repo boundary */
  specifier: string;
}

export interface WorkspaceGraph {
  members: { name: string; root: string; files: number }[];
  /** qualified file -> qualified files it imports (intra- and cross-repo) */
  imports: Map<string, Set<string>>;
  importedBy: Map<string, Set<string>>;
  files: string[];
  /** the cross-repo edges only, for reporting */
  crossEdges: CrossEdge[];
  /** version-skew notes: a member's checkout doesn't satisfy a sibling's declared constraint */
  warnings: string[];
}

// --- TS package publishing --------------------------------------------------

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const TS_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

interface TsPackage {
  name: string;
  /** the package.json's dir, member-relative posix ("" at the repo root) */
  dir: string;
  /** a manifest hint at the entry (source/types/module/main), member-relative if usable */
  hint?: string;
}

function toRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join(path.posix.sep);
}

/** Every package.json in a member (excluding node_modules), each declaring a package `name`. */
function readTsPackages(root: string): TsPackage[] {
  const out: TsPackage[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isFile() && e.name === "package.json") {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(dir, e.name), "utf8")) as Record<string, unknown>;
          if (typeof data["name"] === "string") {
            const hint = entryHint(data);
            out.push({ name: data["name"], dir: toRel(root, dir), ...(hint ? { hint } : {}) });
          }
        } catch {
          /* a malformed package.json contributes no publisher */
        }
      } else if (e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".")) {
        walk(path.join(dir, e.name));
      }
    }
  };
  walk(root);
  return out;
}

/** The first usable entry hint from a package manifest (source, then the `.` export, then fields). */
function entryHint(data: Record<string, unknown>): string | undefined {
  const exports = data["exports"];
  const dotExport =
    typeof exports === "object" && exports !== null
      ? pickString((exports as Record<string, unknown>)["."] ?? exports)
      : undefined;
  for (const candidate of [data["source"], dotExport, data["types"], data["typings"], data["module"], data["main"]]) {
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

/** Pull a file string out of an exports value (a string, or a conditions object like {import,types}). */
function pickString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    for (const key of ["source", "types", "import", "default", "require"]) {
      const v = (value as Record<string, unknown>)[key];
      if (typeof v === "string") return v;
    }
  }
  return undefined;
}

const joinPosix = (...parts: string[]): string => parts.filter((p) => p !== "").join("/").replace(/\/+/g, "/");

/** Candidate source files for a base path: the path itself, source-rewritten (dist→src, .js→.ts),
 *  with each TS extension, and as a directory index. */
function sourceCandidates(base: string): string[] {
  const bases = new Set<string>([base, base.replace(/(^|\/)(dist|lib|build|out)\//, "$1src/").replace(/\.(d\.ts|jsx?|mjs|cjs)$/, "")]);
  const out = new Set<string>();
  for (const b of bases) {
    const noExt = b.replace(/\.[^./]+$/, "");
    out.add(b);
    for (const ext of TS_EXTS) {
      out.add(noExt + ext);
      out.add(joinPosix(noExt, "index") + ext);
    }
  }
  return [...out];
}

/** Resolve a TS package specifier against a member's packages → a member-relative SOURCE file. */
function resolveTsSpecifier(spec: string, packages: TsPackage[], graphFiles: Set<string>): string | null {
  const match = packages
    .filter((p) => spec === p.name || spec.startsWith(p.name + "/"))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (!match) return null;

  const sub = spec === match.name ? "" : spec.slice(match.name.length + 1);
  const candidates: string[] = [];
  if (sub === "") {
    if (match.hint) candidates.push(...sourceCandidates(joinPosix(match.dir, match.hint)));
    for (const idx of ["src/index", "index", "src/main", "lib/index"]) candidates.push(...sourceCandidates(joinPosix(match.dir, idx)));
  } else {
    for (const p of [joinPosix(match.dir, "src", sub), joinPosix(match.dir, sub)]) candidates.push(...sourceCandidates(p));
  }
  return candidates.find((c) => graphFiles.has(c)) ?? null;
}

// --- loading + merge --------------------------------------------------------

interface LoadedMember {
  member: WorkspaceMember;
  graph: FileGraph;
  graphFiles: Set<string>;
  scanners: LanguageScanner[];
  packages: TsPackage[];
}

/** Resolve a specifier from a file of extension `ext` against one sibling; member-relative targets. */
function resolveInSibling(spec: string, ext: string, sibling: LoadedMember): string[] | null {
  if (TS_EXTENSIONS.has(ext)) {
    const file = resolveTsSpecifier(spec, sibling.packages, sibling.graphFiles);
    return file ? [file] : null;
  }
  // Python / Go: the sibling's own resolver answers "do I provide this?" for an absolute import.
  const scanner = sibling.scanners.find((s) => s.extensions.has(ext));
  if (!scanner) return null;
  const probe = path.join(sibling.member.root, `__keel_ws_probe__${ext}`);
  const resolved = scanner.resolveImport(spec, probe);
  if (!resolved) return null;
  const rels = (Array.isArray(resolved) ? resolved : [resolved])
    .map((abs) => toRel(sibling.member.root, abs))
    .filter((rel) => sibling.graphFiles.has(rel));
  return rels.length > 0 ? rels : null;
}

function invert(imports: Map<string, Set<string>>): Map<string, Set<string>> {
  const importedBy = new Map<string, Set<string>>();
  for (const [file, targets] of imports) {
    for (const t of targets) {
      let set = importedBy.get(t);
      if (!set) {
        set = new Set();
        importedBy.set(t, set);
      }
      set.add(file);
    }
  }
  return importedBy;
}

/** Build the merged workspace graph: each member's own graph, namespaced, plus cross-repo edges. */
export async function buildWorkspaceGraph(config: WorkspaceConfig): Promise<WorkspaceGraph> {
  const loaded: LoadedMember[] = [];
  for (const member of config.members) {
    const { graph } = await loadGraph(member.root);
    loaded.push({
      member,
      graph,
      graphFiles: new Set(graph.files),
      scanners: createScanners(member.root),
      packages: readTsPackages(member.root),
    });
  }

  const imports = new Map<string, Set<string>>();
  const files: string[] = [];
  const edge = (from: string, to: string): void => {
    let set = imports.get(from);
    if (!set) {
      set = new Set();
      imports.set(from, set);
    }
    set.add(to);
  };

  // Intra-repo edges, namespaced.
  for (const { member, graph } of loaded) {
    for (const f of graph.files) files.push(qualify(member.name, f));
    for (const [f, targets] of graph.imports) {
      for (const t of targets) edge(qualify(member.name, f), qualify(member.name, t));
    }
  }

  // Cross-repo edges: each member's unresolved specifiers, matched to a sibling's publishing.
  const crossEdges: CrossEdge[] = [];
  for (const from of loaded) {
    const siblings = loaded.filter((m) => m !== from);
    for (const [file, specs] of from.graph.externalImports) {
      const ext = path.posix.extname(file);
      for (const spec of specs) {
        for (const sibling of siblings) {
          const targets = resolveInSibling(spec, ext, sibling);
          if (!targets) continue;
          const qf = qualify(from.member.name, file);
          for (const rel of targets) {
            const qt = qualify(sibling.member.name, rel);
            edge(qf, qt);
            crossEdges.push({ from: qf, to: qt, specifier: spec });
          }
          break; // first sibling that publishes it wins
        }
      }
    }
  }

  crossEdges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return {
    members: loaded.map((l) => ({ name: l.member.name, root: l.member.root, files: l.graph.files.length })),
    imports,
    importedBy: invert(imports),
    files: files.sort(),
    crossEdges,
    warnings: versionSkewWarnings(config.members),
  };
}

/** Everything that transitively depends on `file` across the whole workspace — its blast radius. */
export function workspaceBlastRadius(graph: WorkspaceGraph, file: string): string[] {
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
