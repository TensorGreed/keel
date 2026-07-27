import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseJestJson, runSandbox } from "../src/simulate/sandbox.js";

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

/** A zero-dependency repo whose tests use Node's built-in runner (no npm install needed). */
function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-sbx-"));
  git(dir, ["init", "-b", "main"]);
  write(dir, "package.json", JSON.stringify({ name: "sbx", version: "1.0.0" }) + "\n");
  write(dir, ".gitignore", ".keel/\n");
  write(dir, "sum.js", "exports.sum = (a, b) => a + b;\n");
  write(
    dir,
    "sum.test.js",
    'const test = require("node:test");\nconst assert = require("node:assert");\nconst { sum } = require("./sum.js");\ntest("adds", () => { assert.strictEqual(sum(2, 3), 5); });\n',
  );
  write(
    dir,
    "other.test.js",
    'const test = require("node:test");\ntest("trivial", () => {});\n',
  );
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "init"]);
  return dir;
}

const BREAKING_DIFF = `diff --git a/sum.js b/sum.js
--- a/sum.js
+++ b/sum.js
@@ -1 +1 @@
-exports.sum = (a, b) => a + b;
+exports.sum = (a, b) => a - b;
`;

describe("sandbox runner", () => {
  let dir: string;

  beforeAll(() => {
    dir = initRepo();
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("passes when the selected tests pass on unchanged code", async () => {
    const result = await runSandbox(dir, { testFiles: ["sum.test.js"] });
    expect(result.status).toBe("passed");
    expect(result.runner).toBe("node");
    expect(result.exitCode).toBe(0);
    expect(result.ranTests).toEqual(["sum.test.js"]);
  }, 30_000);

  it("reports failure when a diff breaks the code under test", async () => {
    const result = await runSandbox(dir, { diff: BREAKING_DIFF, testFiles: ["sum.test.js"] });
    expect(result.status).toBe("failed");
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toBeTruthy();
  }, 30_000);

  it("leaves the main working tree untouched after a run", async () => {
    await runSandbox(dir, { diff: BREAKING_DIFF, testFiles: ["sum.test.js"] });
    expect(fs.readFileSync(path.join(dir, "sum.js"), "utf8")).toBe("exports.sum = (a, b) => a + b;\n");
    // no leftover worktrees registered
    const list = execFileSync("git", ["worktree", "list"], { cwd: dir }).toString();
    expect(list).not.toContain("keel-sandbox");
  }, 30_000);

  it("reproduces uncommitted working-tree changes when no diff is given", async () => {
    write(dir, "sum.js", "exports.sum = (a, b) => a - b;\n"); // uncommitted break
    try {
      const result = await runSandbox(dir, { testFiles: ["sum.test.js"] });
      expect(result.status).toBe("failed");
    } finally {
      write(dir, "sum.js", "exports.sum = (a, b) => a + b;\n");
    }
  }, 30_000);

  it("caps the number of tests and reports it", async () => {
    const result = await runSandbox(dir, {
      testFiles: ["sum.test.js", "other.test.js"],
      maxTests: 1,
    });
    expect(result.ranTests).toEqual(["sum.test.js"]);
    expect(result.capped).toEqual({ requested: 2, ran: 1 });
  }, 30_000);

  it("reports no-tests when nothing is selected", async () => {
    const result = await runSandbox(dir, { testFiles: [] });
    expect(result.status).toBe("no-tests");
  });

  it("reports apply-failed for a diff that does not apply", async () => {
    const bogus = `diff --git a/sum.js b/sum.js
--- a/sum.js
+++ b/sum.js
@@ -1 +1 @@
-this line does not exist in the file
+something else
`;
    const result = await runSandbox(dir, { diff: bogus, testFiles: ["sum.test.js"] });
    expect(result.status).toBe("apply-failed");
    // git's own stderr is surfaced, not a generic message.
    expect(result.error).toContain("sum.js");
  }, 30_000);
});

describe("parseJestJson", () => {
  it("normalizes vitest/jest JSON into structured failures", () => {
    const json = JSON.stringify({
      numPassedTests: 1,
      numFailedTests: 1,
      testResults: [
        {
          name: "/tmp/wt/a.test.ts",
          assertionResults: [
            { fullName: "adds works", status: "passed", failureMessages: [] },
            { fullName: "adds broken", status: "failed", failureMessages: ["expected 5, got -1"] },
          ],
        },
      ],
    });
    const parsed = parseJestJson(json, "/tmp/wt");
    expect(parsed).toEqual({
      passed: 1,
      failed: 1,
      failures: [{ name: "adds broken", file: "a.test.ts", message: "expected 5, got -1" }],
    });
  });

  it("keeps a multi-line stack as trace, with message as its first line, capped at 50 lines", () => {
    const stack = ["AssertionError: expected 5 to be -1", ...Array.from({ length: 80 }, (_, i) => `  at frame ${i}`)].join("\n");
    const json = JSON.stringify({
      numPassedTests: 0,
      numFailedTests: 1,
      testResults: [{ name: "/tmp/wt/a.test.ts", assertionResults: [{ fullName: "t", status: "failed", failureMessages: [stack] }] }],
    });
    const parsed = parseJestJson(json, "/tmp/wt")!;
    const failure = parsed.failures[0]!;
    expect(failure.message).toBe("AssertionError: expected 5 to be -1");
    expect(failure.trace).toBeDefined();
    expect(failure.trace!.split("\n")[0]).toBe("AssertionError: expected 5 to be -1");
    // 81-line stack -> 50 kept + a truncation note.
    expect(failure.trace!.split("\n")).toHaveLength(51);
    expect(failure.trace!).toContain("more lines)");
  });

  it("omits trace when the failure is a single line", () => {
    const json = JSON.stringify({
      numFailedTests: 1,
      testResults: [{ name: "/tmp/wt/a.test.ts", assertionResults: [{ fullName: "t", status: "failed", failureMessages: ["boom"] }] }],
    });
    expect(parseJestJson(json, "/tmp/wt")!.failures[0]).toEqual({ name: "t", file: "a.test.ts", message: "boom" });
  });

  it("returns null for non-JSON", () => {
    expect(parseJestJson("not json", "/tmp/wt")).toBeNull();
  });
});
