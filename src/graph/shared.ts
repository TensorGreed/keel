/**
 * Language-agnostic graph basics shared by the composer (dependencies.ts) and the individual
 * language scanners. Kept in its own module so a scanner can import these without depending on
 * dependencies.ts, which imports the scanner registry (avoids an import cycle).
 */
import * as path from "node:path";

/** Directories never walked or resolved into — build output, VCS, vendored deps, and language
 *  virtual-environments (Python's venv/site-packages/caches). `.venv`/`.tox` are also covered by
 *  the dotfile rule in listSourceFiles/isGraphSourcePath; listed here so both paths agree. */
export const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage", ".next", "out",
  "venv", ".venv", "__pycache__", ".tox", "site-packages",
]);

/** An absolute path as a repo-relative posix path — the form every graph key uses. */
export function toRepoRelative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join(path.posix.sep);
}
