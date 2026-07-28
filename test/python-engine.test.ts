import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getImpact } from "../src/simulate/impact.js";
import { changedRoots, selectTests } from "../src/simulate/select-tests.js";
import { preflight } from "../src/simulate/preflight.js";
import { loadGraph, loadHeadGraph, resetGraphCache } from "../src/graph/cache.js";
import { reportFor } from "../src/graph/dependencies.js";
import { initPythonScanner } from "../src/graph/python-scanner.js";

// The scoping engines (impact, select_tests) and preflight on a pure-Python repo. Graph
// analysis and test selection work; the sim runner is JS-only, so preflight says so honestly.

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

const BREAK_CALC = `diff --git a/calc.py b/calc.py
--- a/calc.py
+++ b/calc.py
@@ -1,2 +1,2 @@
 def add(a, b):
-    return a + b
+    return a - b
`;

beforeAll(async () => {
  await initPythonScanner();
});

describe("pure-Python repo: impact, select_tests, preflight", () => {
  let dir: string;
  beforeEach(() => {
    resetGraphCache();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-py-"));
    git(dir, ["init", "-b", "main"]);
    write(dir, ".gitignore", ".keel/\n");
    write(dir, "calc.py", "def add(a, b):\n    return a + b\n");
    write(dir, "test_calc.py", "from calc import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "init"]);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("get_impact maps a .py change to its dependents", async () => {
    const impact = await getImpact(dir, { diff: BREAK_CALC });
    if ("error" in impact) throw new Error(impact.error);
    expect(impact.impactedFiles).toEqual(["test_calc.py"]); // test_calc imports calc
  });

  it("select_tests picks the test_*.py that covers the change", async () => {
    const impact = await getImpact(dir, { diff: BREAK_CALC });
    if ("error" in impact) throw new Error(impact.error);
    const { graph } = await loadHeadGraph(dir);
    const sel = selectTests(graph, changedRoots(impact.changedFiles));
    expect(sel.tests.map((t) => t.file)).toEqual(["test_calc.py"]);
    expect(sel.uncoveredChanges).toEqual([]);
  }, 15_000);

  it("preflight reports runner-unsupported for Python rather than pretending", async () => {
    const pf = await preflight(dir, { diff: BREAK_CALC });
    if ("error" in pf) throw new Error(pf.error);
    expect(pf.executed.status).toBe("runner-unsupported");
    expect(pf.executed.error).toMatch(/python not yet supported/);
    expect(pf.testsSelected).toEqual(["test_calc.py"]); // selection still works
  }, 30_000);
});

describe("incremental rescan of a .py file", () => {
  let dir: string;
  beforeEach(() => {
    resetGraphCache();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-pyinc-"));
    git(dir, ["init", "-b", "main"]);
    write(dir, ".gitignore", ".keel/\n");
    write(dir, "a.py", "def x():\n    return 1\n");
    write(dir, "b.py", "def y():\n    return 2\n"); // b doesn't import a yet
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "init"]);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("rescans only the edited .py and picks up its new edge", async () => {
    const first = await loadGraph(dir); // builds + writes the disk cache (tree clean)
    expect(reportFor(first.graph, "b.py").dependencies).toEqual([]);

    // Content-only edit: b now imports a. No files added/removed -> incremental path.
    resetGraphCache();
    fs.writeFileSync(path.join(dir, "b.py"), "from a import x\n\n\ndef y():\n    return x()\n");
    const second = await loadGraph(dir);
    expect(second.source).toBe("incremental");
    expect(reportFor(second.graph, "b.py").dependencies).toEqual(["a.py"]);
  }, 15_000);
});
