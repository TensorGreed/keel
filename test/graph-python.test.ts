import { beforeAll, describe, expect, it } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFileGraph, reportFor, transitiveDependents, type FileGraph } from "../src/graph/dependencies.js";
import { initPythonScanner } from "../src/graph/python-scanner.js";

// Python graph analysis via the web-tree-sitter scanner. buildFileGraph is synchronous but the
// Python parser needs a one-time async init first.
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

beforeAll(async () => {
  await initPythonScanner();
});

describe("python: flat package, relative imports, star, __all__", () => {
  let g: FileGraph;
  beforeAll(() => {
    g = buildFileGraph(path.join(fixtures, "python-flat"));
  });

  it("resolves an absolute intra-repo import with its symbol", () => {
    const r = reportFor(g, "pkg/service.py");
    expect(r.dependencies).toContain("pkg/util.py");
    expect(r.importsFrom["pkg/util.py"]).toEqual(["helper"]);
  });

  it("resolves relative imports at level 1 (.util) and level 2 (..util)", () => {
    expect(reportFor(g, "pkg/relimport.py").dependencies).toEqual(["pkg/util.py"]); // from .util
    expect(reportFor(g, "pkg/sub/leaf.py").dependencies).toEqual(["pkg/util.py"]); // from ..util
  });

  it("treats a star import as the whole module (*)", () => {
    expect(reportFor(g, "pkg/star.py").importsFrom["pkg/util.py"]).toEqual(["*"]);
  });

  it("reports dependents and the transitive blast radius", () => {
    const r = reportFor(g, "pkg/util.py");
    expect(r.dependents).toEqual(["pkg/relimport.py", "pkg/service.py", "pkg/star.py", "pkg/sub/leaf.py"]);
    // app.py -> pkg/service.py -> pkg/util.py, so app is in the blast radius too.
    expect(transitiveDependents(g, "pkg/util.py")).toContain("app.py");
    expect(transitiveDependents(g, "pkg/util.py")).toHaveLength(5);
  });

  it("`from pkg import service` edges to the submodule (and the package __init__)", () => {
    expect(reportFor(g, "app.py").dependencies).toEqual(["pkg/__init__.py", "pkg/service.py"]);
  });

  it("respects a literal __all__ and treats a computed one as opaque", () => {
    expect(reportFor(g, "pkg/util.py").exports).toEqual(["helper"]); // __all__ = ["helper"] hides _private
    expect(reportFor(g, "pkg/dynamic.py").exports).toEqual(["*"]); // __all__ = names (computed)
    expect(reportFor(g, "pkg/service.py").exports).toEqual(["serve"]); // top-level def, no __all__
  });
});

describe("python: src/ layout", () => {
  it("resolves absolute imports through a pyproject package-dir = src root", () => {
    const g = buildFileGraph(path.join(fixtures, "python-src"));
    const r = reportFor(g, "src/mypkg/api.py");
    expect(r.dependencies).toEqual(["src/mypkg/core.py"]); // `from mypkg.core import run` via the src root
    expect(r.importsFrom["src/mypkg/core.py"]).toEqual(["run"]);
    expect(reportFor(g, "src/mypkg/core.py").dependents).toEqual(["src/mypkg/api.py"]);
  });
});

describe("python: namespace package (no __init__.py)", () => {
  it("resolves modules inside a namespace package but not the package itself", () => {
    const g = buildFileGraph(path.join(fixtures, "python-namespace"));
    const r = reportFor(g, "app.py");
    // `import ns.mod` and `from ns import other` -> the two modules; the bare `ns` package has no
    // __init__.py, so it contributes no file edge (only its modules resolve).
    expect(r.dependencies).toEqual(["ns/mod.py", "ns/other.py"]);
    expect(r.importsFrom["ns/mod.py"]).toEqual(["*"]);
  });
});
