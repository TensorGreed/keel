import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { buildFileGraph, reportFor } from "../src/graph/dependencies.js";

describe("symbol-level dependencies", () => {
  const graph = buildFileGraph(path.join(__dirname, "fixtures", "symbols"));
  const lib = reportFor(graph, "src/lib.ts");

  it("lists a file's exports, including the default export", () => {
    expect(lib.exports).toEqual(["alpha", "beta", "default", "gamma"]);
  });

  it("records named imports by their source-side name, aliases included", () => {
    expect(reportFor(graph, "src/named.ts").importsFrom).toEqual({
      "src/lib.ts": ["alpha", "beta"],
    });
  });

  it("records default imports as 'default'", () => {
    expect(lib.usedBy["src/defaulted.ts"]).toEqual(["default"]);
  });

  it("narrows namespace imports to the members actually accessed", () => {
    expect(lib.usedBy["src/star.ts"]).toEqual(["alpha", "gamma"]);
  });

  it("marks an escaping namespace object as using the whole module", () => {
    expect(lib.usedBy["src/star-escape.ts"]).toEqual(["*"]);
  });

  it("records side-effect-only imports as using no symbols", () => {
    expect(lib.usedBy["src/effects.ts"]).toEqual([]);
  });

  it("attributes named re-exports and export-star in barrels", () => {
    expect(reportFor(graph, "src/barrel.ts").importsFrom).toEqual({
      "src/lib.ts": ["alpha"],
      "src/util.ts": ["*"],
    });
    expect(reportFor(graph, "src/barrel.ts").exports).toEqual(["*", "alpha"]);
  });

  it("marks dynamic import() as using the whole module", () => {
    expect(lib.usedBy["src/dynamic.ts"]).toEqual(["*"]);
  });

  it("covers every dependent in usedBy", () => {
    expect(Object.keys(lib.usedBy).sort()).toEqual(lib.dependents);
  });
});

describe("symbol-level detail across workspace packages", () => {
  const graph = buildFileGraph(path.join(__dirname, "fixtures", "workspace"));

  it("attributes symbols over cross-package edges", () => {
    const shared = reportFor(graph, "packages/shared/src/index.ts");
    expect(shared.exports).toEqual(["shared"]);
    expect(shared.usedBy).toEqual({ "packages/app/src/main.ts": ["shared"] });
  });

  it("attributes symbols over aliased edges", () => {
    const aliased = buildFileGraph(path.join(__dirname, "fixtures", "aliased"));
    expect(reportFor(aliased, "src/utils.ts").usedBy).toEqual({
      "src/feature.ts": ["greet"],
    });
  });
});
