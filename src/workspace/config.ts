/**
 * Workspace config — `keel.workspace.json`, the list of repos that make up one logical system.
 * A workspace lets keel span repo boundaries: a shared library repo, the services that consume it,
 * a frontend and a backend. The file is small and hand-authored:
 *
 *   { "repos": [ { "path": "../shared" }, { "path": "../api", "name": "api" } ] }
 *
 * Paths are relative to the config file. A member's name defaults to its directory basename and is
 * how its files are addressed in the merged graph (`name::path/to/file`).
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface WorkspaceMember {
  /** the member's name — its namespace in the merged graph (`name::relpath`) */
  name: string;
  /** absolute path to the member repo */
  root: string;
}

export interface WorkspaceConfig {
  file: string;
  root: string;
  members: WorkspaceMember[];
}

const CONFIG_NAME = "keel.workspace.json";

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

/** Locate keel.workspace.json: KEEL_WORKSPACE (a file or a dir holding one), else walk up from `startDir`. */
export function findWorkspaceConfig(startDir: string): string | null {
  const env = process.env["KEEL_WORKSPACE"];
  if (env) {
    const p = path.resolve(env);
    if (isFile(p)) return p;
    const inDir = path.join(p, CONFIG_NAME);
    return isFile(inDir) ? inDir : null;
  }
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, CONFIG_NAME);
    if (isFile(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadWorkspaceConfig(startDir: string): WorkspaceConfig | { error: string } {
  const file = findWorkspaceConfig(startDir);
  if (!file) return { error: `no ${CONFIG_NAME} found (set KEEL_WORKSPACE, or add one at the workspace root)` };

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { error: `${file}: invalid JSON (${(e as Error).message})` };
  }
  const repos = (raw as { repos?: unknown } | null)?.repos;
  if (!Array.isArray(repos)) return { error: `${file}: expected { "repos": [ { "path": "..." } ] }` };

  const base = path.dirname(file);
  const members: WorkspaceMember[] = [];
  const seen = new Set<string>();
  for (const entry of repos) {
    const rel = typeof entry === "string" ? entry : (entry as { path?: unknown })?.path;
    if (typeof rel !== "string" || rel.trim() === "") return { error: `${file}: each repo needs a "path"` };
    const root = path.resolve(base, rel);
    if (!isDir(root)) return { error: `${file}: repo path not found: ${rel}` };
    const explicit = typeof entry === "object" && entry !== null ? (entry as { name?: unknown }).name : undefined;
    const name = typeof explicit === "string" && explicit.trim() !== "" ? explicit.trim() : path.basename(root);
    if (seen.has(name)) return { error: `${file}: duplicate repo name "${name}" — give each a distinct "name"` };
    seen.add(name);
    members.push({ name, root });
  }
  if (members.length === 0) return { error: `${file}: no repos listed` };
  return { file, root: base, members };
}
