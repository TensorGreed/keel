/**
 * Cross-platform helpers for the test suite. The suite has to be green on Windows as well as
 * POSIX (see .github/workflows/ci.yml), and four things differ in ways that show up as flakes or
 * hard failures rather than as anything obviously platform-shaped:
 *
 *   - **Deleting a temp tree.** Windows holds a lock briefly after a process exits or a handle
 *     closes, so a plain recursive delete in `afterEach` intermittently throws EBUSY/EPERM/
 *     ENOTEMPTY. Node's own remedy is `maxRetries`.
 *   - **`npm` is a batch shim there** (`npm.cmd`), which `execFileSync` cannot run without a shell.
 *   - **Directory links** need a junction, not a `"dir"` symlink (which wants elevation).
 *   - **A `#!/bin/sh` stub isn't executable.** Where the point of a stub is only "this command
 *     fails", a `.cmd` does the same job; where the stub needs real shell scripting, the test says
 *     so and skips.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { IS_WINDOWS, linkDir, spawnSpec } from "../../src/util/platform.js";

export { IS_WINDOWS };

/**
 * Recursively delete a temp directory, tolerating Windows' post-exit locks. Always use this in
 * `afterEach` instead of a bare `fs.rmSync`: a lingering lock there is a timing artefact, not a
 * fact about the code under test, and letting it throw fails an otherwise-passing test.
 */
export function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

/**
 * Run an external tool synchronously the same way the sandbox runner would — resolved on PATH,
 * through cmd.exe if it turns out to be a batch shim. Tests use this to probe whether the host has
 * a toolchain: a bare `execFileSync("mvn", …)` on Windows throws EINVAL even when Maven is
 * installed, which would silently turn a real capability into a skip.
 */
export function toolSync(cmd: string, args: string[], opts: Parameters<typeof execFileSync>[2] = {}): string {
  const spec = spawnSpec(cmd, args);
  const out = execFileSync(spec.command, spec.args, { ...opts, shell: spec.shell });
  return out?.toString() ?? "";
}

/** Run npm synchronously, through a shell on Windows (npm there is `npm.cmd`). */
export function npmSync(args: string[], opts: { cwd: string; stdio?: "ignore" | "pipe" }): string {
  const out = execFileSync(IS_WINDOWS ? "npm.cmd" : "npm", args, {
    cwd: opts.cwd,
    shell: IS_WINDOWS,
    encoding: "utf8",
    ...(opts.stdio ? { stdio: opts.stdio } : {}),
  });
  return out ?? "";
}

/** Link keel's own node_modules into a fixture repo so it can share the installed test runner. */
export function linkNodeModules(target: string, at: string): void {
  linkDir(target, path.join(at, "node_modules"));
}

/**
 * Write an executable stub named `name` in `dir` that always exits non-zero — enough to shadow a
 * real tool on PATH and make its version probe fail deterministically. A `.cmd` on Windows (which
 * is what PATH resolution looks for there), a `#!/bin/sh` script elsewhere.
 */
export function writeFailingShim(dir: string, name: string): void {
  if (IS_WINDOWS) {
    fs.writeFileSync(path.join(dir, `${name}.cmd`), "@echo off\r\nexit /b 1\r\n");
    return;
  }
  const file = path.join(dir, name);
  fs.writeFileSync(file, "#!/bin/sh\nexit 1\n");
  fs.chmodSync(file, 0o755);
}
