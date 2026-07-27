import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { buildFileGraph, reportFor } from "../src/graph/dependencies.js";

describe("tsconfig path aliases", () => {
  const graph = buildFileGraph(path.join(__dirname, "fixtures", "aliased"));

  it("scans all source files", () => {
    expect(graph.files).toEqual(["src/feature.ts", "src/main.ts", "src/utils.ts"]);
  });

  it("resolves aliased imports to in-repo files", () => {
    const report = reportFor(graph, "src/feature.ts");
    expect(report.dependencies).toEqual(["src/utils.ts"]);
    expect(report.dependents).toEqual(["src/main.ts"]);
  });

  it("keeps node_modules packages out of the graph", () => {
    // src/main.ts imports "typescript", which resolves into keel's own node_modules.
    const report = reportFor(graph, "src/main.ts");
    expect(report.dependencies).toEqual(["src/feature.ts"]);
  });

  it("computes the blast radius through aliased edges", () => {
    const report = reportFor(graph, "src/utils.ts");
    expect(report.dependents).toEqual(["src/feature.ts"]);
    expect(report.transitiveDependents).toEqual(["src/feature.ts", "src/main.ts"]);
  });
});

describe("npm workspace monorepo", () => {
  const graph = buildFileGraph(path.join(__dirname, "fixtures", "workspace"));

  it("scans source files, skipping built output", () => {
    expect(graph.files).toEqual([
      "packages/app/src/cli.ts",
      "packages/app/src/main.ts",
      "packages/shared/src/helpers.ts",
      "packages/shared/src/index.ts",
    ]);
  });

  it("resolves cross-package imports to the package's source entry, not dist", () => {
    const report = reportFor(graph, "packages/app/src/main.ts");
    expect(report.dependencies).toEqual(["packages/shared/src/index.ts"]);
  });

  it("resolves subpath imports into a workspace package", () => {
    const report = reportFor(graph, "packages/app/src/cli.ts");
    expect(report.dependencies).toEqual([
      "packages/app/src/main.ts",
      "packages/shared/src/helpers.ts",
    ]);
  });

  it("reports dependents across the package boundary", () => {
    const report = reportFor(graph, "packages/shared/src/index.ts");
    expect(report.dependents).toEqual(["packages/app/src/main.ts"]);
  });

  it("computes the blast radius across packages", () => {
    const report = reportFor(graph, "packages/shared/src/index.ts");
    expect(report.transitiveDependents).toEqual([
      "packages/app/src/cli.ts",
      "packages/app/src/main.ts",
    ]);
  });
});

describe("pnpm workspace monorepo", () => {
  const graph = buildFileGraph(path.join(__dirname, "fixtures", "workspace-pnpm"));

  it("resolves cross-package imports declared in pnpm-workspace.yaml", () => {
    const report = reportFor(graph, "packages/web/main.ts");
    expect(report.dependencies).toEqual(["packages/core/index.ts"]);
  });

  it("reports dependents and blast radius across packages", () => {
    const report = reportFor(graph, "packages/core/index.ts");
    expect(report.dependents).toEqual(["packages/web/main.ts"]);
    expect(report.transitiveDependents).toEqual(["packages/web/main.ts"]);
  });
});
