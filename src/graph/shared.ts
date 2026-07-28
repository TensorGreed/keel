/**
 * Language-agnostic graph basics shared by the composer (dependencies.ts) and the individual
 * language scanners. Kept in its own module so a scanner can import these without depending on
 * dependencies.ts, which imports the scanner registry (avoids an import cycle).
 */
import * as path from "node:path";

/** Directories never walked or resolved into — build output, VCS, and vendored deps. Language
 *  scanners may add their own (e.g. Python's venv dirs) but this is the shared baseline. */
export const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", "out"]);

/** An absolute path as a repo-relative posix path — the form every graph key uses. */
export function toRepoRelative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join(path.posix.sep);
}
