import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { buildFileGraph, reportFor } from "../src/graph/dependencies.js";

const fixture = path.join(__dirname, "fixtures", "sample");

describe("file graph", () => {
  const graph = buildFileGraph(fixture);

  it("scans all source files", () => {
    expect(graph.files).toEqual([
      "src/api.ts",
      "src/config.ts",
      "src/db.ts",
      "src/standalone.ts",
    ]);
  });

  it("resolves direct imports", () => {
    const report = reportFor(graph, "src/db.ts");
    expect(report.dependencies).toEqual(["src/config.ts"]);
    expect(report.dependents).toEqual(["src/api.ts"]);
  });

  it("computes the transitive blast radius", () => {
    const report = reportFor(graph, "src/config.ts");
    expect(report.transitiveDependents).toEqual(["src/api.ts", "src/db.ts"]);
  });

  it("reports empty blast radius for leaf files", () => {
    const report = reportFor(graph, "src/standalone.ts");
    expect(report.dependencies).toEqual([]);
    expect(report.dependents).toEqual([]);
    expect(report.transitiveDependents).toEqual([]);
  });
});
