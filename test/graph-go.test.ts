import { beforeAll, describe, expect, it } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFileGraph, reportFor, transitiveDependents, type FileGraph } from "../src/graph/dependencies.js";
import { initGoScanner } from "../src/graph/go-scanner.js";

// Go graph analysis via the web-tree-sitter scanner. buildFileGraph is synchronous but the Go
// parser needs a one-time async init first. These resolver/scanner tests never shell out to `go`,
// so they always run (no toolchain required).
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

beforeAll(async () => {
  await initGoScanner();
});

describe("go: single module, nested packages, import forms", () => {
  let g: FileGraph;
  beforeAll(() => {
    g = buildFileGraph(path.join(fixtures, "go-module"));
  });

  it("an import edges to EVERY non-test .go file of the target package (one compilation unit)", () => {
    // main.go imports example.com/app/greet, whose package is greet.go + more.go.
    const r = reportFor(g, "main.go");
    expect(r.dependencies).toContain("greet/greet.go");
    expect(r.dependencies).toContain("greet/more.go");
  });

  it("an aliased import pulls the whole package (*)", () => {
    // `g "example.com/app/greet"` — the alias is local; the whole package is still imported.
    expect(reportFor(g, "main.go").importsFrom["greet/greet.go"]).toEqual(["*"]);
  });

  it("a dot-import pulls the whole package (*)", () => {
    // `. "example.com/app/dotpkg"`
    expect(reportFor(g, "main.go").importsFrom["dotpkg/dot.go"]).toEqual(["*"]);
  });

  it("a blank import is a side-effect-only edge (empty symbols)", () => {
    // `_ "example.com/app/sidepkg"` — the edge exists, but nothing is used.
    const r = reportFor(g, "main.go");
    expect(r.dependencies).toContain("sidepkg/side.go");
    expect(r.importsFrom["sidepkg/side.go"]).toEqual([]);
  });

  it("resolves an internal/ package like any other (visibility is a compiler concern)", () => {
    expect(reportFor(g, "greet/greet.go").dependencies).toEqual(["internal/util/util.go"]);
  });

  it("exports capitalized funcs/types/vars/consts; a method attributes to its receiver type", () => {
    // Greeter (type), Greet (method -> Greeter), Hello (func), Prefix (var), Version (const).
    expect(reportFor(g, "greet/greet.go").exports).toEqual(["Greeter", "Hello", "Prefix", "Version"]);
    expect(reportFor(g, "internal/util/util.go").exports).toEqual(["Config", "Helper", "Limit"]);
  });

  it("does not export unexported (lowercase) names", () => {
    // sidepkg/side.go has only `func init()` and `var registered` — nothing exported.
    expect(reportFor(g, "sidepkg/side.go").exports).toEqual([]);
  });

  it("connects a same-package test file to its package's non-test files", () => {
    // greet_test.go is `package greet` — it compiles with the package but imports nothing from it.
    const r = reportFor(g, "greet/greet_test.go");
    expect(r.dependencies).toEqual(["greet/greet.go", "greet/more.go"]);
  });

  it("connects a black-box (pkg_test) test file through its explicit import", () => {
    // greet_bb_test.go is `package greet_test` and imports example.com/app/greet.
    const r = reportFor(g, "greet/greet_bb_test.go");
    expect(r.dependencies).toEqual(["greet/greet.go", "greet/more.go"]);
  });

  it("a change to a package file lists both its same-package and black-box tests as dependents", () => {
    const r = reportFor(g, "greet/greet.go");
    expect(r.dependents).toEqual(["greet/greet_bb_test.go", "greet/greet_test.go", "main.go"]);
    // main.go transitively depends on the package too.
    expect(transitiveDependents(g, "greet/greet.go")).toContain("main.go");
  });
});

describe("go: go.work two-module workspace", () => {
  it("resolves a cross-module import via the other module's go.mod path", () => {
    const g = buildFileGraph(path.join(fixtures, "go-workspace"));
    // app (module example.com/app) imports example.com/lib/greet from the sibling lib module.
    const r = reportFor(g, "app/main.go");
    expect(r.dependencies).toEqual(["lib/greet/greet.go"]);
    expect(r.importsFrom["lib/greet/greet.go"]).toEqual(["*"]);
    expect(reportFor(g, "lib/greet/greet.go").dependents).toEqual(["app/main.go"]);
  });
});
