import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { preflight } from "../src/simulate/preflight.js";
import { resetGraphCache } from "../src/graph/cache.js";
import { initGraphScanners } from "../src/graph/scanners.js";

// The pytest sandbox runner. The runner-unavailable path is asserted deterministically (a stub
// interpreter that has no pytest); the executed path needs a real pytest, so it skips cleanly
// when the host has none — the runner-unavailable path stands in as the always-on assertion.

function hostHasPytest(): boolean {
  try {
    execFileSync("python3", ["-m", "pytest", "--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const PYTEST = hostHasPytest();

function git(dir: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "D", GIT_AUTHOR_EMAIL: "d@e.com", GIT_COMMITTER_NAME: "D", GIT_COMMITTER_EMAIL: "d@e.com",
      GIT_AUTHOR_DATE: "2021-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2021-01-01T00:00:00Z",
    },
  });
}
function write(dir: string, rel: string, contents: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), contents);
}

/** A tiny flat-package Python repo with one pytest test that asserts add(1,2) == 3. */
function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-pytest-"));
  git(dir, ["init", "-b", "main"]);
  write(dir, ".gitignore", ".venv/\n.keel/\n");
  write(dir, "calc.py", "def add(a, b):\n    return a + b\n");
  write(dir, "test_calc.py", "from calc import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "init"]);
  return dir;
}

const BREAK = `diff --git a/calc.py b/calc.py
--- a/calc.py
+++ b/calc.py
@@ -1,2 +1,2 @@
 def add(a, b):
-    return a + b
+    return a - b
`;

let dir: string;
beforeAll(async () => {
  await initGraphScanners();
});
beforeEach(() => {
  resetGraphCache();
  dir = makeRepo();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("pytest runner — unavailable path (always)", () => {
  it("reports runner-unavailable, naming the interpreter, when pytest can't run", async () => {
    // A stub .venv interpreter that fails `-m pytest --version` — findPythonInterpreter prefers it,
    // so this is deterministic regardless of whether the host has pytest.
    write(dir, ".venv/bin/python", "#!/bin/sh\nexit 1\n");
    fs.chmodSync(path.join(dir, ".venv/bin/python"), 0o755);

    const pf = await preflight(dir, { diff: BREAK });
    if ("error" in pf) throw new Error(pf.error);
    expect(pf.executed.status).toBe("runner-unavailable");
    expect(pf.executed.error).toMatch(/pytest is not available/);
    expect(pf.executed.error).toContain(".venv/bin/python"); // names the interpreter tried
    expect(pf.testsSelected).toEqual(["test_calc.py"]); // selection still works
  }, 30_000);
});

describe.skipIf(!PYTEST)("pytest runner — executed path (host pytest)", () => {
  it("executes the change and returns failures with a graph path to it", async () => {
    const pf = await preflight(dir, { diff: BREAK });
    if ("error" in pf) throw new Error(pf.error);
    expect(pf.executed.status).toBe("failed");
    expect(pf.executed.failed).toBeGreaterThanOrEqual(1);
    const failure = pf.executed.failures.find((f) => f.file === "test_calc.py");
    expect(failure).toBeDefined();
    expect(failure!.graphPath).toEqual(["test_calc.py", "calc.py"]);
  }, 60_000);

  it("passes a benign change", async () => {
    const benign = BREAK.replace("+    return a - b", "+    return a + b + 0");
    const pf = await preflight(dir, { diff: benign });
    if ("error" in pf) throw new Error(pf.error);
    expect(pf.executed.status).toBe("passed");
    expect(pf.executed.passed).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
