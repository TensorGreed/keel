import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { preflight } from "../src/simulate/preflight.js";
import { resetGraphCache } from "../src/graph/cache.js";
import { initGraphScanners } from "../src/graph/scanners.js";
import { IS_WINDOWS, rmDir, toolSync } from "./helpers/platform.js";

// The pytest sandbox runner. The runner-unavailable path is asserted deterministically (a stub
// interpreter that has no pytest); the executed path needs a real pytest, so it skips cleanly
// when the host has none — the runner-unavailable path stands in as the always-on assertion.

function hostHasPytest(): boolean {
  try {
    toolSync(IS_WINDOWS ? "python" : "python3", ["-m", "pytest", "--version"], { stdio: "ignore" });
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

/**
 * A repo shaped like a real project: a main package with a passing test, plus an examples/
 * sub-project that depends on something not installed in the venv. `kind` chooses how it breaks:
 * a broken test-file import (a recoverable collection error, with --continue-on-collection-errors)
 * or a broken conftest (fatal on modern pytest — aborts the whole run, no report).
 */
function makeSubprojectRepo(kind: "testfile" | "conftest"): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "keel-pysub-"));
  git(d, ["init", "-b", "main"]);
  write(d, ".gitignore", ".venv/\n.keel/\n");
  write(d, "pkg/__init__.py", "");
  write(d, "pkg/helpers.py", 'def greet():\n    return "hi"\n');
  write(d, "tests/test_helpers.py", "from pkg.helpers import greet\n\n\ndef test_greet():\n    assert greet() == \"hi\"\n");
  const brokenImport = "import totally_not_installed_xyz  # not in the venv\n";
  write(d, "examples/demo/test_demo.py", (kind === "testfile" ? brokenImport : "") + "from pkg.helpers import greet\n\n\ndef test_demo():\n    assert greet()\n");
  if (kind === "conftest") write(d, "examples/demo/conftest.py", brokenImport);
  git(d, ["add", "-A"]);
  git(d, ["commit", "-qm", "init"]);
  return d;
}
/**
 * A main package plus N example sub-projects, each with its own conftest.py that imports an
 * uninstalled package (fatal to load). Every test imports pkg.helpers, so a change to it selects
 * all of them — reproducing the pallets/flask shape where selected tests span several broken
 * example trees. pytest aborts on the first bad conftest, so clearing them takes one retry each.
 */
function makeMultiConftestRepo(examples: number): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "keel-pyconf-"));
  git(d, ["init", "-b", "main"]);
  write(d, ".gitignore", ".venv/\n.keel/\n");
  write(d, "pkg/__init__.py", "");
  write(d, "pkg/helpers.py", 'def greet():\n    return "hi"\n');
  write(d, "tests/test_helpers.py", "from pkg.helpers import greet\n\n\ndef test_greet():\n    assert greet() == \"hi\"\n");
  for (let i = 0; i < examples; i++) {
    write(d, `examples/ex${i}/conftest.py`, `import totally_missing_pkg_${i}_xyz  # not in the venv\n`);
    write(d, `examples/ex${i}/test_ex${i}.py`, `from pkg.helpers import greet\n\n\ndef test_ex${i}():\n    assert greet()\n`);
  }
  git(d, ["add", "-A"]);
  git(d, ["commit", "-qm", "init"]);
  return d;
}
// Break the main package so its test fails — and pulls in the examples sub-project (it imports pkg too).
const SUB_BREAK = `diff --git a/pkg/helpers.py b/pkg/helpers.py
--- a/pkg/helpers.py
+++ b/pkg/helpers.py
@@ -1,2 +1,2 @@
 def greet():
-    return "hi"
+    return "bye"
`;
const ANSI = /\x1b\[|#x1[bB]\[/; // real ESC or pytest's escaped placeholder

let dir: string;
beforeAll(async () => {
  await initGraphScanners();
});
beforeEach(() => {
  resetGraphCache();
  dir = makeRepo();
});
afterEach(() => rmDir(dir));

// POSIX-only: the stub is a `#!/bin/sh` interpreter, and there is no portable way to fake a
// `Scripts\python.exe` on Windows (findPythonInterpreter looks for a real executable there, as it
// must). The behaviour under test — a venv interpreter that can't import pytest yields
// runner-unavailable naming it — is platform-independent, so covering it on POSIX is enough.
describe.skipIf(IS_WINDOWS)("pytest runner — unavailable path (POSIX: needs an executable stub interpreter)", () => {
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
  it("executes the change, names the runner, and returns failures with a graph path", async () => {
    const pf = await preflight(dir, { diff: BREAK });
    if ("error" in pf) throw new Error(pf.error);
    expect(pf.executed.status).toBe("failed");
    expect(pf.executed.runner).toBe("pytest"); // runner reported (was undefined before)
    expect(pf.executed.failed).toBeGreaterThanOrEqual(1);
    const failure = pf.executed.failures.find((f) => f.file === "test_calc.py");
    expect(failure).toBeDefined();
    expect(failure!.graphPath).toEqual(["test_calc.py", "calc.py"]);
  }, 60_000);

  it("carries file, trace, and graphPath on a pytest failure — parity with the JS/Go runners", async () => {
    const pf = await preflight(dir, { diff: BREAK });
    if ("error" in pf) throw new Error(pf.error);
    const failure = pf.executed.failures.find((f) => f.test === "test_add");
    expect(failure).toBeDefined();
    // file recovered from the junit (classname/file attributes)
    expect(failure!.file).toBe("test_calc.py");
    // graph path attributed exactly as the other runners do
    expect(failure!.graphPath).toEqual(["test_calc.py", "calc.py"]);
    // the full traceback carried as trace (the <failure> text), not just the one-line message
    expect(failure!.message).toContain("assert -1 == 3");
    expect(failure!.trace).toBeDefined();
    expect(failure!.trace).toMatch(/test_calc\.py:\d+/); // the assertion location, from the traceback
    expect(failure!.trace!.split("\n").length).toBeGreaterThan(1); // multi-line, unlike the message
    expect(failure!.trace).not.toMatch(ANSI);
  }, 60_000);

  it("passes a benign change", async () => {
    const benign = BREAK.replace("+    return a - b", "+    return a + b + 0");
    const pf = await preflight(dir, { diff: benign });
    if ("error" in pf) throw new Error(pf.error);
    expect(pf.executed.status).toBe("passed");
    expect(pf.executed.passed).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("surfaces real failures even when a sub-project can't be collected", async () => {
    const repo = makeSubprojectRepo("testfile");
    try {
      const pf = await preflight(repo, { diff: SUB_BREAK });
      if ("error" in pf) throw new Error(pf.error);
      expect(pf.executed.status).toBe("failed");
      expect(pf.executed.runner).toBe("pytest");

      // the main package's real failure still surfaces, with its graph path
      const real = pf.executed.failures.find((f) => f.file === "tests/test_helpers.py");
      expect(real).toBeDefined();
      expect(real!.kind).toBeUndefined();
      expect(real!.graphPath).toEqual(["tests/test_helpers.py", "pkg/helpers.py"]);

      // the broken sub-project is its own collection-error record — not a mask over everything
      const coll = pf.executed.failures.find((f) => f.file === "examples/demo/test_demo.py");
      expect(coll?.kind).toBe("collection-error");
      expect(coll!.message).toContain("totally_not_installed_xyz");
      expect(coll!.message).not.toMatch(ANSI); // ImportError line, no ANSI

      // status reflects real results: both the failure and the collection error are counted
      expect(pf.executed.failed).toBeGreaterThanOrEqual(2);
    } finally {
      rmDir(repo);
    }
  }, 60_000);

  it("reports a failed run honestly (with a clean output tail) when a broken conftest aborts it", async () => {
    const repo = makeSubprojectRepo("conftest");
    try {
      const pf = await preflight(repo, { diff: SUB_BREAK });
      if ("error" in pf) throw new Error(pf.error);
      // Modern pytest aborts on a fatal conftest (no report). Whichever way it goes, we never
      // report a silent failed+empty: the run failed and the reason is in a cleaned output tail.
      expect(pf.executed.status).toBe("failed");
      expect(pf.executed.runner).toBe("pytest");
      const evidence = `${pf.executed.output ?? ""}\n${pf.executed.failures.map((f) => f.message).join("\n")}`;
      expect(evidence).toContain("totally_not_installed_xyz");
      expect(pf.executed.output ?? "").not.toMatch(ANSI); // ANSI stripped from the tail
    } finally {
      rmDir(repo);
    }
  }, 60_000);

  it("excludes multiple broken-conftest subtrees across retries and still surfaces the real failure", async () => {
    // Two example sub-projects each abort pytest on load. The bounded exclude-and-retry loop must
    // clear both (one retry each) and still run the main package, whose real failure surfaces.
    const repo = makeMultiConftestRepo(2);
    try {
      const started = Date.now();
      const pf = await preflight(repo, { diff: SUB_BREAK, maxSeconds: 60 });
      const wallMs = Date.now() - started;
      if ("error" in pf) throw new Error(pf.error);

      expect(pf.executed.status).toBe("failed");
      expect(pf.executed.runner).toBe("pytest");

      // Both broken example trees are excluded — each its own collection-error, not a mask.
      for (const i of [0, 1]) {
        const coll = pf.executed.failures.find((f) => f.file === `examples/ex${i}/test_ex${i}.py`);
        expect(coll?.kind).toBe("collection-error");
        expect(coll!.message).toContain(`totally_missing_pkg_${i}_xyz`);
        expect(coll!.message).not.toMatch(ANSI);
      }

      // The main package's real failure still surfaces, with a graph path to the change.
      const real = pf.executed.failures.find((f) => f.file === "tests/test_helpers.py");
      expect(real).toBeDefined();
      expect(real!.kind).toBeUndefined();
      expect(real!.graphPath).toEqual(["tests/test_helpers.py", "pkg/helpers.py"]);

      // 1 real + 2 collection errors; wall time stays within the cumulative budget.
      expect(pf.executed.failed).toBe(3);
      expect(pf.executed.durationMs).toBeLessThan(60_000);
      expect(wallMs).toBeLessThan(60_000);
    } finally {
      rmDir(repo);
    }
  }, 90_000);

  it("never reports failed with an empty failures list (the empty-failures rule)", async () => {
    // The exact regression: a broken conftest used to abort the run into status "failed",
    // failures: []. Now the abort is converted into recorded collection errors — so whenever the
    // status is failed, there is always at least one failure to point at.
    const repo = makeMultiConftestRepo(1);
    try {
      const pf = await preflight(repo, { diff: SUB_BREAK });
      if ("error" in pf) throw new Error(pf.error);
      expect(pf.executed.status).toBe("failed");
      expect(pf.executed.failures.length).toBeGreaterThan(0);
    } finally {
      rmDir(repo);
    }
  }, 60_000);
});
