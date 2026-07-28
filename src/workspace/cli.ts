/**
 * `keel workspace` — query the cross-repo graph. Summarizes the workspace and its cross-repo edges,
 * or reports the blast radius / direct edges of a file across repo boundaries. Offline and
 * deterministic; lazy-loaded from index.ts.
 */
import { loadWorkspaceConfig } from "./config.js";
import { buildWorkspaceGraph, memberOf, workspaceBlastRadius, type WorkspaceGraph } from "./graph.js";

const HELP = `keel workspace — one dependency graph spanning several repos

Usage:
  keel workspace                  summarize the workspace and its cross-repo edges
  keel workspace impact <file>    the cross-repo blast radius of a file
  keel workspace deps <file>      a file's direct dependencies and dependents

Files are addressed as <repo-name>::<repo-relative-path> (e.g. shared::src/index.ts).
Configure via keel.workspace.json at the workspace root (or KEEL_WORKSPACE):
  { "repos": [ { "path": "../shared" }, { "path": "../api", "name": "api" } ] }`;

function warn(message: string): void {
  process.stderr.write(`[keel] ${message}\n`);
}

const cross = (file: string, other: string): boolean => memberOf(file) !== memberOf(other);

function summarize(g: WorkspaceGraph): number {
  console.log(`[keel] workspace: ${g.members.length} repo(s), ${g.files.length} file(s), ${g.crossEdges.length} cross-repo edge(s)`);
  for (const m of g.members) console.log(`  - ${m.name} (${m.files} file(s)) — ${m.root}`);
  if (g.crossEdges.length > 0) {
    console.log("cross-repo edges:");
    for (const e of g.crossEdges) console.log(`  ${e.from} -> ${e.to}  [${e.specifier}]`);
  } else {
    console.log("(no cross-repo edges found — members don't import each other's published packages)");
  }
  return 0;
}

/** Group qualified files by their member, each list sorted. */
function byMember(files: string[]): [string, string[]][] {
  const groups = new Map<string, string[]>();
  for (const f of files) {
    const m = memberOf(f);
    (groups.get(m) ?? groups.set(m, []).get(m)!).push(f);
  }
  return [...groups].map(([m, fs]) => [m, fs.sort()] as [string, string[]]).sort(([a], [b]) => a.localeCompare(b));
}

function requireFile(g: WorkspaceGraph, file: string): boolean {
  if (g.files.includes(file)) return true;
  warn(`"${file}" is not a workspace file — address it as <repo-name>::<path> (see \`keel workspace\`)`);
  return false;
}

function impact(g: WorkspaceGraph, file: string): number {
  if (!requireFile(g, file)) return 1;
  const radius = workspaceBlastRadius(g, file);
  const crossRepo = radius.filter((f) => cross(f, file));
  console.log(`[keel] ${file}: ${radius.length} transitive dependent(s), ${crossRepo.length} in other repos`);
  for (const [m, files] of byMember(radius)) {
    console.log(`  ${m}${m === memberOf(file) ? " (same repo)" : ""}:`);
    for (const f of files) console.log(`    ${f}`);
  }
  return 0;
}

function deps(g: WorkspaceGraph, file: string): number {
  if (!requireFile(g, file)) return 1;
  const dependencies = [...(g.imports.get(file) ?? [])].sort();
  const dependents = [...(g.importedBy.get(file) ?? [])].sort();
  console.log(`[keel] ${file}`);
  console.log(`  imports (${dependencies.length}):`);
  for (const d of dependencies) console.log(`    -> ${d}${cross(d, file) ? "  [cross-repo]" : ""}`);
  console.log(`  imported by (${dependents.length}):`);
  for (const d of dependents) console.log(`    <- ${d}${cross(d, file) ? "  [cross-repo]" : ""}`);
  return 0;
}

export async function runWorkspace(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "--help" || sub === "-h") {
    console.log(HELP);
    return 0;
  }

  const cfg = loadWorkspaceConfig(process.cwd());
  if ("error" in cfg) {
    warn(`workspace: ${cfg.error}`);
    return 1;
  }
  const graph = await buildWorkspaceGraph(cfg);

  if (sub === undefined) return summarize(graph);
  if (sub === "impact" || sub === "deps") {
    const file = rest[0];
    if (file === undefined) {
      warn(`workspace ${sub}: needs a file (as <repo-name>::<path>)`);
      return 1;
    }
    return sub === "impact" ? impact(graph, file) : deps(graph, file);
  }
  warn(`workspace: unknown subcommand "${sub}" (use impact, deps, or no argument)`);
  return 1;
}
