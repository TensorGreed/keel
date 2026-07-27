import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { buildFileGraph, reportFor, transitiveDependents } from "../src/graph/dependencies.js";

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

describe("import cycle (a -> b -> a)", () => {
  const graph = buildFileGraph(path.join(__dirname, "fixtures", "cycle"));

  // A 5s test timeout guards termination: without the visited-set, a cycle would loop forever.
  it("terminates and excludes the queried file from its own transitive dependents", () => {
    // b depends on a (and a on b), but a must not list itself.
    expect(transitiveDependents(graph, "a.ts")).toEqual(["b.ts"]);
    expect(transitiveDependents(graph, "b.ts")).toEqual(["a.ts"]);
  }, 5_000);

  it("reports the cycle through reportFor without self-inclusion", () => {
    const report = reportFor(graph, "a.ts");
    expect(report.dependencies).toEqual(["b.ts"]);
    expect(report.dependents).toEqual(["b.ts"]);
    expect(report.transitiveDependents).toEqual(["b.ts"]); // not ["a.ts", "b.ts"]
  }, 5_000);
});
