import { describe, expect, it } from "vitest";
import type { FileGraph } from "../src/graph/dependencies.js";
import { computeHotspots, coveredFiles, describeHotspot } from "../src/trust/hotspots.js";

/** Graph from an import map, ensuring every file is a key in `imports` (like a real graph). */
function makeGraph(edges: Record<string, string[]>): FileGraph {
  const imports = new Map<string, Set<string>>();
  for (const [f, deps] of Object.entries(edges)) imports.set(f, new Set(deps));
  const importedBy = new Map<string, Set<string>>();
  for (const [f, deps] of imports) for (const d of deps) (importedBy.get(d) ?? importedBy.set(d, new Set()).get(d)!).add(f);
  const files = [...new Set([...imports.keys(), ...importedBy.keys()])];
  for (const f of files) if (!imports.has(f)) imports.set(f, new Set());
  return { imports, importedBy, importSymbols: new Map(), exportsOf: new Map(), files };
}

// core.ts has 3 dependents (a,b,c); a.test.ts covers a.ts -> core.ts; leaf.ts is uncovered.
function fixture(): FileGraph {
  return makeGraph({
    "src/core.ts": [],
    "src/a.ts": ["src/core.ts"],
    "src/b.ts": ["src/core.ts"],
    "src/c.ts": ["src/core.ts"],
    "src/a.test.ts": ["src/a.ts"],
    "src/leaf.ts": [],
  });
}

describe("coveredFiles", () => {
  it("is the set of sources reached by some test file", () => {
    const covered = coveredFiles(fixture());
    expect(covered.has("src/a.ts")).toBe(true); // a.test.ts -> a.ts
    expect(covered.has("src/core.ts")).toBe(true); // a.test.ts -> a.ts -> core.ts
    expect(covered.has("src/leaf.ts")).toBe(false); // no test reaches it
  });
});

describe("computeHotspots", () => {
  it("scores churn × (blastRadius+1) × coverageGap and shows the components", () => {
    const churn = new Map([["src/core.ts", 4]]);
    const [h] = computeHotspots(fixture(), churn, coveredFiles(fixture()));
    // core.ts dependents: a.ts, b.ts, c.ts, and a.test.ts (via a.ts) = 4.
    expect(h).toMatchObject({ path: "src/core.ts", commits: 4, blastRadius: 4, covered: true });
    expect(h!.score).toBe(4 * (4 + 1) * 1); // covered -> gap factor 1
  });

  it("doubles the score of an uncovered file", () => {
    const churn = new Map([["src/leaf.ts", 5]]);
    const [h] = computeHotspots(fixture(), churn, coveredFiles(fixture()));
    expect(h).toMatchObject({ path: "src/leaf.ts", commits: 5, blastRadius: 0, covered: false });
    expect(h!.score).toBe(5 * (0 + 1) * 2); // uncovered leaf still ranks, and is penalized
  });

  it("excludes files with no churn in the window and test files", () => {
    const churn = new Map([["src/a.ts", 2], ["src/a.test.ts", 9]]); // core/leaf have no churn
    const spots = computeHotspots(fixture(), churn, coveredFiles(fixture()));
    expect(spots.map((h) => h.path)).toEqual(["src/a.ts"]); // no-churn files gone, test file excluded
  });

  it("ranks by score, and honors the limit", () => {
    const churn = new Map([
      ["src/core.ts", 4], // 4*(3+1)*1 = 16
      ["src/leaf.ts", 5], // 5*(0+1)*2 = 10
      ["src/a.ts", 1], //    1*(1+1)*1 = 2  (a.ts has 1 dependent: a.test.ts)
    ]);
    const spots = computeHotspots(fixture(), churn, coveredFiles(fixture()));
    expect(spots.map((h) => h.path)).toEqual(["src/core.ts", "src/leaf.ts", "src/a.ts"]);
    expect(computeHotspots(fixture(), churn, coveredFiles(fixture()), { limit: 2 }).map((h) => h.path)).toEqual([
      "src/core.ts",
      "src/leaf.ts",
    ]);
  });

  it("describes a hotspot with all its components", () => {
    const churn = new Map([["src/leaf.ts", 5]]);
    const line = describeHotspot(computeHotspots(fixture(), churn, coveredFiles(fixture()))[0]!);
    expect(line).toContain("src/leaf.ts");
    expect(line).toContain("5 commits");
    expect(line).toContain("UNCOVERED");
  });
});
