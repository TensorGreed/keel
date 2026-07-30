/**
 * Language-agnostic graph basics shared by the composer (dependencies.ts) and the individual
 * language scanners. Kept in its own module so a scanner can import these without depending on
 * dependencies.ts, which imports the scanner registry (avoids an import cycle).
 */
import * as path from "node:path";
import { canonicalPath } from "../util/platform.js";

/** Directories never walked or resolved into — build output, VCS, vendored deps, and language
 *  virtual-environments (Python's venv/site-packages/caches). `.venv`/`.tox` are also covered by
 *  the dotfile rule in listSourceFiles/isGraphSourcePath; listed here so both paths agree. */
export const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage", ".next", "out",
  "venv", ".venv", "__pycache__", ".tox", "site-packages",
  "vendor", "testdata", // Go: vendored deps and test-only data are never part of the graph
]);

/**
 * The repo root in the one canonical form the whole graph build compares against: resolved
 * through symlinks and Windows 8.3 short names. Resolution has to realpath the files it finds
 * (a workspace install symlinks into node_modules), so unless the root is in the same space
 * every `startsWith(root)` containment check fails and edges silently vanish — for a repo under
 * `%TEMP%` on a CI runner (`C:\Users\RUNNER~1\…`) or under macOS's `/var` → `/private/var`.
 * Graph keys stay repo-*relative*, so canonicalizing the root changes no output.
 */
export function graphRoot(repoRoot: string): string {
  return canonicalPath(repoRoot);
}

/** An absolute path as a repo-relative posix path — the form every graph key uses. */
export function toRepoRelative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join(path.posix.sep);
}
