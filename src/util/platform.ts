/**
 * Platform differences keel has to cope with, in one place. Everything here exists because
 * Windows is not POSIX in four specific ways that bite a tool which spawns processes, links
 * directories, and keys a graph by relative path:
 *
 *   1. **Batch shims.** Most Node/JVM tooling installs on Windows as a `.cmd`/`.bat` shim, not an
 *      executable. `CreateProcess` cannot run one, and since Node 20.12 (CVE-2024-27980) `spawn`
 *      refuses `.cmd`/`.bat` without `shell: true` rather than silently mis-quoting. So a call site
 *      must know both *which* file a bare name resolves to and whether it needs a shell.
 *   2. **PATHEXT.** A bare `mvn` on PATH is really `mvn.cmd`; probing for it with an exec call
 *      reports "missing" when it's installed. Presence has to be resolved, not executed.
 *   3. **Directory links.** `symlink(…, "dir")` needs Developer Mode or elevation; a *junction*
 *      does not. And removing a junction is `rmdir`, not `unlink` — get it wrong and a recursive
 *      delete can walk through the link into the real tree.
 *   4. **Path canonicalization.** `%TEMP%` on a CI runner is often an 8.3 short path
 *      (`C:\Users\RUNNER~1\…`), and drive-letter case is not stable. Any `startsWith(root)`
 *      containment check against a `realpath`-ed path fails unless both sides are canonical.
 *
 * Pure logic and `fs` only — no process spawning here, so this module stays outside the
 * timeout audit's remit (see test/timeout-audit.test.ts); it only says *how* to spawn.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const IS_WINDOWS = process.platform === "win32";

/** Extensions Windows will execute for a bare name, in the order we prefer them: a real
 *  executable before a shim, because an executable needs no shell. */
const WINDOWS_EXEC_EXTS = [".exe", ".com", ".cmd", ".bat"];

/** A shim cmd.exe must interpret rather than a file CreateProcess can run. */
export function isBatchFile(file: string): boolean {
  return /\.(?:cmd|bat)$/i.test(file);
}

/**
 * The absolute file a bare command name resolves to on PATH, or null. Windows-aware: a name
 * without an extension is tried against PATHEXT-style extensions, so `mvn` finds `mvn.cmd`.
 * Presence only — it never runs anything.
 */
export function resolveOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (name.includes("/") || name.includes(path.sep)) {
    return isFile(name) ? path.resolve(name) : null;
  }
  // PATH only — deliberately *not* the current directory, which Windows' own CreateProcess would
  // search first. Honouring that would make "is this tool installed?" depend on the contents of
  // whatever repo we're pointed at, and would let a file dropped in a repo shadow a real tool.
  const dirs = (env["PATH"] ?? "").split(path.delimiter).filter(Boolean);
  const exts = IS_WINDOWS ? (path.extname(name) ? [""] : WINDOWS_EXEC_EXTS) : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Quote one argument for cmd.exe. Node's `shell: true` on Windows joins argv with spaces into a
 * single `cmd /d /s /c "…"` line without quoting anything, so a call site that needs a shell has
 * to quote for itself. Caveat, stated rather than papered over: `%VAR%` inside double quotes is
 * still expanded by cmd. keel only ever shells out to a build tool with flags it generated
 * itself, so no argument here carries a literal `%`.
 */
export function quoteForCmd(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"^&|<>()!,;=]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  /** true when the command is a Windows batch shim and must go through cmd.exe */
  shell: boolean;
}

/**
 * How to actually spawn `command args` on this platform. On POSIX this is the identity. On
 * Windows a bare name is resolved to a concrete file first (so PATHEXT ambiguity is settled
 * once), and a `.cmd`/`.bat` shim is marked `shell: true` with everything pre-quoted.
 *
 * Pass the result straight through to spawn/execFile: `spawn(s.command, s.args, { shell: s.shell })`.
 */
export function spawnSpec(command: string, args: string[]): SpawnSpec {
  if (!IS_WINDOWS) return { command, args, shell: false };
  const resolved = resolveOnPath(command) ?? command;
  if (!isBatchFile(resolved)) return { command: resolved, args, shell: false };
  return { command: quoteForCmd(resolved), args: args.map(quoteForCmd), shell: true };
}

/**
 * The JavaScript entry of a locally-installed package's bin, resolved from the package's own
 * `bin` field — e.g. `node_modules/vitest` → `node_modules/vitest/vitest.mjs`. Spawning that with
 * `process.execPath` is identical on every platform and skips both `npx` (a process layer, and a
 * `.cmd` shim on Windows) and `node_modules/.bin` (whose POSIX entry is a shebang script Windows
 * cannot execute). Returns null when the package isn't installed under `dir`.
 */
export function localPackageBin(dir: string, pkg: string, binName: string): string | null {
  const pkgDir = path.join(dir, "node_modules", pkg);
  let manifest: { bin?: string | Record<string, string> };
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) as typeof manifest;
  } catch {
    return null;
  }
  const bin = manifest.bin;
  const entry = typeof bin === "string" ? bin : bin?.[binName];
  if (!entry) return null;
  const abs = path.join(pkgDir, entry);
  return isFile(abs) ? abs : null;
}

/**
 * Link `target` (a directory) at `linkPath`, sharing it without a copy. Uses a **junction** on
 * Windows: a `"dir"` symlink there requires Developer Mode or elevation, while a junction needs
 * neither. Returns false if the link couldn't be made (callers treat that as "no shared deps",
 * never as fatal).
 */
export function linkDir(target: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(target, linkPath, IS_WINDOWS ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove a directory *link* without following it. A junction must be `rmdir`-ed (unlink gives
 * EPERM), a POSIX symlink must be `unlink`-ed (rmdir gives ENOTDIR) — and getting it wrong risks
 * a recursive delete walking through the link into the real tree. Best effort: a missing link is
 * success.
 */
export function unlinkDir(linkPath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(linkPath);
  } catch {
    return; // nothing there
  }
  if (!stat.isSymbolicLink() && !stat.isDirectory()) return; // a real file — not ours to remove
  for (const remove of [fs.rmdirSync, fs.unlinkSync]) {
    try {
      remove(linkPath);
      return;
    } catch {
      // try the other shape
    }
  }
}

/**
 * The canonical absolute form of a path, for containment comparisons: resolved through symlinks
 * and Windows 8.3 short names via `realpath.native`, which also normalizes drive-letter and
 * directory case. Falls back to `path.resolve` when the path doesn't exist yet.
 *
 * Every `startsWith(root + sep)` check must have both sides through here, or a repo under
 * `%TEMP%` (short-named on CI runners) or `/var` (a symlink to `/private/var` on macOS) silently
 * looks like it's outside its own root.
 */
export function canonicalPath(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
