import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildFileGraph } from "../src/graph/dependencies.js";
import {
  changedRoots,
  coverageOf,
  isTestFile,
  selectTests,
  testCoverageMap,
} from "../src/simulate/select-tests.js";
import { getImpact } from "../src/simulate/impact.js";
import { loadGraph, loadHeadGraph, resetGraphCache } from "../src/graph/cache.js";

function write(dir: string, rel: string, contents: string): void {
  const target = path.join(dir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

/**
 * lib <- usesLib; each has a test. helper <- deep <- deep.test (transitive coverage).
 * orphan has no test. isolated.test covers nothing but itself.
 */
function makeFixture(dir: string): void {
  write(dir, "lib.ts", "export const lib = 1;\n");
  write(dir, "usesLib.ts", 'import { lib } from "./lib.js";\nexport const u = lib + 1;\n');
  write(dir, "lib.test.ts", 'import { lib } from "./lib.js";\nexport const t = lib;\n');
  write(dir, "usesLib.test.ts", 'import { u } from "./usesLib.js";\nexport const t = u;\n');
  write(dir, "helper.ts", "export const helper = 2;\n");
  write(dir, "deep.ts", 'import { helper } from "./helper.js";\nexport const d = helper;\n');
  write(dir, "__tests__/deep.test.ts", 'import { d } from "../deep.js";\nexport const t = d;\n');
  write(dir, "orphan.ts", "export const orphan = 3;\n");
  write(dir, "isolated.test.ts", "export const t = 1;\n");
}

describe("isTestFile", () => {
  it("recognizes .test/.spec files and test directories", () => {
    expect(isTestFile("foo.test.ts")).toBe(true);
    expect(isTestFile("a/b/foo.spec.tsx")).toBe(true);
    expect(isTestFile("pkg/__tests__/foo.ts")).toBe(true);
    expect(isTestFile("test/foo.ts")).toBe(true);
    expect(isTestFile("src/foo.ts")).toBe(false);
    expect(isTestFile("README.md")).toBe(false);
  });
});

describe("test selection (pure graph)", () => {
  let dir: string;
  let graph: ReturnType<typeof buildFileGraph>;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-select-"));
    makeFixture(dir);
    graph = buildFileGraph(dir);
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("maps a test to the sources it covers", () => {
    expect(coverageOf(graph, "usesLib.test.ts")).toEqual(["lib.ts", "usesLib.ts"]);
    expect(testCoverageMap(graph)["__tests__/deep.test.ts"]).toEqual(["deep.ts", "helper.ts"]);
  });

  it("selects the direct and transitive tests covering a change", () => {
    const selection = selectTests(graph, ["lib.ts"]);
    expect(selection.tests.map((t) => t.file)).toEqual(["lib.test.ts", "usesLib.test.ts"]);
    expect(selection.testCount).toBe(2);
    expect(selection.uncoveredChanges).toEqual([]);
    // usesLib.test reaches lib through usesLib.
    expect(selection.paths["usesLib.test.ts"]).toEqual(["usesLib.test.ts", "usesLib.ts", "lib.ts"]);
    expect(selection.tests.find((t) => t.file === "lib.test.ts")!.covers).toEqual(["lib.ts"]);
  });

  it("selects transitively through a non-test intermediate", () => {
    const selection = selectTests(graph, ["helper.ts"]);
    expect(selection.tests.map((t) => t.file)).toEqual(["__tests__/deep.test.ts"]);
    expect(selection.paths["__tests__/deep.test.ts"]).toEqual([
      "__tests__/deep.test.ts",
      "deep.ts",
      "helper.ts",
    ]);
  });

  it("reports a changed source with no covering test as uncovered", () => {
    const selection = selectTests(graph, ["orphan.ts"]);
    expect(selection.tests).toEqual([]);
    expect(selection.uncoveredChanges).toEqual(["orphan.ts"]);
  });

  it("selects a changed test file itself, and never marks a test uncovered", () => {
    const selection = selectTests(graph, ["isolated.test.ts"]);
    expect(selection.tests).toEqual([{ file: "isolated.test.ts", covers: ["isolated.test.ts"] }]);
    expect(selection.uncoveredChanges).toEqual([]);
  });

  it("selects a brand-new test not yet in the graph", () => {
    const selection = selectTests(graph, ["brandnew.test.ts"]);
    expect(selection.tests.map((t) => t.file)).toEqual(["brandnew.test.ts"]);
    expect(selection.uncoveredChanges).toEqual([]);
  });
});

// --- integration with getImpact (diff -> roots -> selection) ----------------

function git(dir: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Dev",
      GIT_AUTHOR_EMAIL: "dev@example.com",
      GIT_COMMITTER_NAME: "Dev",
      GIT_COMMITTER_EMAIL: "dev@example.com",
      GIT_AUTHOR_DATE: "2021-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2021-01-01T00:00:00Z",
    },
  });
}

async function selectionFor(dir: string, diff?: string) {
  const impact = await getImpact(dir, diff !== undefined ? { diff } : {});
  if ("error" in impact) throw new Error(impact.error);
  const { graph } = await loadHeadGraph(dir);
  return selectTests(graph, changedRoots(impact.changedFiles));
}

describe("test selection from a diff", () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-select-git-"));
    git(dir, ["init", "-b", "main"]);
    write(dir, ".gitignore", ".keel/\n");
    makeFixture(dir);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "init"]);
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    resetGraphCache();
  });

  it("selects tests covering the old path when a file is deleted", async () => {
    const diff = `diff --git a/lib.ts b/lib.ts
deleted file mode 100644
--- a/lib.ts
+++ /dev/null
@@ -1 +0,0 @@
-export const lib = 1;
`;
    const selection = await selectionFor(dir, diff);
    expect(selection.tests.map((t) => t.file)).toEqual(["lib.test.ts", "usesLib.test.ts"]);
  });

  it("selects tests covering the old path when a file is renamed", async () => {
    const diff = `diff --git a/helper.ts b/helper2.ts
similarity index 100%
rename from helper.ts
rename to helper2.ts
`;
    const selection = await selectionFor(dir, diff);
    expect(selection.tests.map((t) => t.file)).toEqual(["__tests__/deep.test.ts"]);
  });

  it("rejects a non-applying diff up front (same validation as preflight)", async () => {
    // select_tests routes through getImpact, so it rejects exactly what git apply would.
    const diff = `diff --git a/lib.ts b/lib.ts
--- a/lib.ts
+++ b/lib.ts
@@ -1 +1 @@
-export const nonexistent = 0;
+export const nonexistent = 1;
`;
    const impact = await getImpact(dir, { diff });
    expect("error" in impact).toBe(true);
    if ("error" in impact) expect(impact.error).toContain("does not apply");
  });

  it("uses working-tree changes when no diff is given", async () => {
    resetGraphCache();
    await loadGraph(dir); // warm the baseline
    write(dir, "helper.ts", "export const helper = 22;\n");
    resetGraphCache();

    const selection = await selectionFor(dir);
    expect(selection.tests.map((t) => t.file)).toEqual(["__tests__/deep.test.ts"]);

    // restore for isolation
    write(dir, "helper.ts", "export const helper = 2;\n");
  });
});
