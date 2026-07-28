import { beforeAll, describe, expect, it } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFileGraph, reportFor, type FileGraph } from "../src/graph/dependencies.js";
import { selectTests } from "../src/simulate/select-tests.js";
import { initPythonScanner } from "../src/graph/python-scanner.js";

// Regression: pallets/flask shape — a `src/<pkg>/` layout that flit auto-detects with NO
// package-dir config, and tests/ that import the package by name. Before the fix, `import flask`
// from tests/ resolved to nothing: the whole test suite was graph-disconnected, select_tests
// returned 0, and uncoveredChanges lied. src/ must be a root by convention, not just by config.
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "python-src-convention");

describe("python src-layout by convention (flask shape)", () => {
  let g: FileGraph;
  beforeAll(async () => {
    await initPythonScanner();
    g = buildFileGraph(fixture);
  });

  it("connects tests to the package even with no package-dir config", () => {
    // `from mypkg.core import run` in tests/test_core.py resolves against src/ by convention.
    expect(reportFor(g, "tests/test_core.py").dependencies).toEqual(["src/mypkg/core.py"]);
    // The whole package tree is connected (not orphaned).
    expect(reportFor(g, "src/mypkg/core.py").dependencies).toEqual(["src/mypkg/util.py"]);
  });

  it("select_tests finds the covering test for a src change, with nothing uncovered", () => {
    const direct = selectTests(g, ["src/mypkg/core.py"]);
    expect(direct.tests.map((t) => t.file)).toContain("tests/test_core.py");
    expect(direct.uncoveredChanges).toEqual([]);

    // A change deeper in the package is still covered transitively (test -> core -> util).
    const transitive = selectTests(g, ["src/mypkg/util.py"]);
    expect(transitive.tests.map((t) => t.file)).toContain("tests/test_core.py");
    expect(transitive.uncoveredChanges).toEqual([]);
  });
});
