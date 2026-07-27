import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { preflight, type PreflightResult } from "../src/simulate/preflight.js";
import { resetGraphCache } from "../src/graph/cache.js";

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

function write(dir: string, rel: string, contents: string): void {
  const target = path.join(dir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function ok(result: PreflightResult | { error: string }): PreflightResult {
  if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
  return result;
}

// --- node:test fixture (zero-dep) for orchestration -------------------------

/** sum <- mid; each has a test. orphan has no test. */
function initNodeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-pf-"));
  git(dir, ["init", "-b", "main"]);
  write(dir, ".gitignore", ".keel/\n");
  write(dir, "package.json", JSON.stringify({ name: "pf", version: "1.0.0" }) + "\n");
  write(dir, "sum.js", "exports.sum = (a, b) => a + b;\n");
  write(dir, "mid.js", 'const { sum } = require("./sum.js");\nexports.mid = () => sum(1, 1);\n');
  write(
    dir,
    "sum.test.js",
    'const test = require("node:test");\nconst assert = require("node:assert");\nconst { sum } = require("./sum.js");\ntest("sum", () => assert.strictEqual(sum(2, 3), 5));\n',
  );
  write(
    dir,
    "mid.test.js",
    'const test = require("node:test");\nconst assert = require("node:assert");\nconst { mid } = require("./mid.js");\ntest("mid", () => assert.strictEqual(mid(), 2));\n',
  );
  write(dir, "orphan.js", "exports.orphan = 1;\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "init"]);
  return dir;
}

const benignSum = `diff --git a/sum.js b/sum.js
--- a/sum.js
+++ b/sum.js
@@ -1 +1 @@
-exports.sum = (a, b) => a + b;
+exports.sum = (a, b) => (a) + (b);
`;
const breakingSum = `diff --git a/sum.js b/sum.js
--- a/sum.js
+++ b/sum.js
@@ -1 +1 @@
-exports.sum = (a, b) => a + b;
+exports.sum = (a, b) => a - b;
`;

describe("preflight orchestration", () => {
  let dir: string;

  beforeAll(() => {
    dir = initNodeRepo();
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    resetGraphCache();
  });

  it("always reports the budget with defaults, even with nothing to run", async () => {
    const result = ok(await preflight(dir)); // clean tree -> no changes
    expect(result.executed.status).toBe("no-tests");
    expect(result.testsSelected).toEqual([]);
    expect(result.budget).toEqual({ maxTests: 50, maxSeconds: 120, testsSkipped: [], truncated: false });
  }, 30_000);

  it("runs the covering tests and reports failure for a breaking diff", async () => {
    const result = ok(await preflight(dir, { diff: breakingSum }));
    expect(result.testsSelected.sort()).toEqual(["mid.test.js", "sum.test.js"]);
    expect(result.impacted).toContain("sum.test.js");
    expect(result.executed.status).toBe("failed");
  }, 30_000);

  it("caps tests by maxTests, running those nearest the change first", async () => {
    const result = ok(await preflight(dir, { diff: benignSum, maxTests: 1 }));
    // sum.test.js is one hop from sum.js; mid.test.js is two -> mid is skipped.
    expect(result.budget.truncated).toBe(true);
    expect(result.budget.testsSkipped).toEqual(["mid.test.js"]);
    expect(result.executed.status).toBe("passed");
  }, 30_000);

  it("honors KEEL_MAX_TESTS from the environment", async () => {
    process.env["KEEL_MAX_TESTS"] = "1";
    try {
      const result = ok(await preflight(dir, { diff: benignSum }));
      expect(result.budget.maxTests).toBe(1);
      expect(result.budget.truncated).toBe(true);
    } finally {
      delete process.env["KEEL_MAX_TESTS"];
    }
  }, 30_000);

  it("rejects a non-applying diff up front with git's message, never throwing", async () => {
    const bogus = `diff --git a/sum.js b/sum.js
--- a/sum.js
+++ b/sum.js
@@ -1 +1 @@
-this is not the real content
+something else
`;
    const result = await preflight(dir, { diff: bogus });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("does not apply");
      expect(result.error).toContain("sum.js"); // git's own stderr
    }
  }, 30_000);

  it("returns a bad diff as an error", async () => {
    const result = await preflight(dir, { diff: "diff --git a/x b/x\n@@ nope @@\n" });
    expect("error" in result).toBe(true);
  });

  it("surfaces changed files that no test covers", async () => {
    const diff = `diff --git a/orphan.js b/orphan.js
--- a/orphan.js
+++ b/orphan.js
@@ -1 +1 @@
-exports.orphan = 1;
+exports.orphan = 2;
`;
    const result = ok(await preflight(dir, { diff }));
    expect(result.uncoveredChanges).toEqual(["orphan.js"]);
    expect(result.testsSelected).toEqual([]);
  }, 30_000);
});

// --- vitest fixture: structured failures + graphPath ------------------------

const KEEL_NODE_MODULES = path.resolve(__dirname, "..", "node_modules");

describe("preflight with vitest (structured failures)", () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-pf-vitest-"));
    git(dir, ["init", "-b", "main"]);
    write(dir, ".gitignore", "node_modules/\n.keel/\n");
    write(
      dir,
      "package.json",
      JSON.stringify({ name: "pfv", version: "1.0.0", type: "module", devDependencies: { vitest: "*" } }) + "\n",
    );
    write(dir, "sum.ts", "export const sum = (a: number, b: number): number => a + b;\n");
    write(
      dir,
      "sum.test.ts",
      'import { test, expect } from "vitest";\nimport { sum } from "./sum.js";\ntest("sum adds", () => {\n  expect(sum(2, 3)).toBe(5);\n});\n',
    );
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "init"]);
    // Share keel's installed vitest without a per-fixture npm install.
    fs.symlinkSync(KEEL_NODE_MODULES, path.join(dir, "node_modules"), "dir");
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    resetGraphCache();
  });

  it("returns structured failures with a graph path to the change", async () => {
    const diff = `diff --git a/sum.ts b/sum.ts
--- a/sum.ts
+++ b/sum.ts
@@ -1 +1 @@
-export const sum = (a: number, b: number): number => a + b;
+export const sum = (a: number, b: number): number => a - b;
`;
    const result = ok(await preflight(dir, { diff }));
    expect(result.executed.status).toBe("failed");
    expect(result.executed.failed).toBeGreaterThanOrEqual(1);
    const failure = result.executed.failures.find((f) => f.file === "sum.test.ts");
    expect(failure).toBeDefined();
    expect(failure!.graphPath).toEqual(["sum.test.ts", "sum.ts"]);
    // The full assertion stack comes through as trace, message is its first line.
    expect(failure!.trace).toBeDefined();
    expect(failure!.trace!.split("\n").length).toBeGreaterThan(1);
    expect(failure!.trace!.startsWith(failure!.message)).toBe(true);
  }, 60_000);
});
