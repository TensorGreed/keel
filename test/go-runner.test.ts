import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { preflight } from "../src/simulate/preflight.js";
import { resetGraphCache } from "../src/graph/cache.js";
import { initGraphScanners } from "../src/graph/scanners.js";
import { rmDir, toolSync, writeFailingShim } from "./helpers/platform.js";

// The Go sandbox runner. The runner-unavailable path is asserted deterministically (a `go` shim on
// PATH that exits non-zero); the executed path needs a real go toolchain, so it skips cleanly when
// the host has none. The resolver/graph tests (graph-go.test.ts) always run regardless.

function hostHasGo(): boolean {
  try {
    toolSync("go", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const GO = hostHasGo();

function git(dir: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "D", GIT_AUTHOR_EMAIL: "d@e.com", GIT_COMMITTER_NAME: "D", GIT_COMMITTER_EMAIL: "d@e.com",
      GIT_AUTHOR_DATE: "2021-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2021-01-01T00:00:00Z",
    },
  });
}
function write(dir: string, rel: string, contents: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), contents);
}

/** A tiny Go module: package calc with Add, and a passing + failing test pair against it. */
function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-go-"));
  git(dir, ["init", "-b", "main"]);
  write(dir, ".gitignore", ".keel/\n");
  write(dir, "go.mod", "module example.com/app\n\ngo 1.20\n");
  write(dir, "calc/calc.go", "package calc\n\nfunc Add(a, b int) int {\n\treturn a + b\n}\n");
  write(
    dir,
    "calc/calc_test.go",
    [
      "package calc",
      "",
      'import "testing"',
      "",
      "func TestAlwaysOk(t *testing.T) {",
      "\tif Add(0, 0) != 0 {",
      '\t\tt.Fatal("Add(0,0) should be 0")',
      "\t}",
      "}",
      "",
      "func TestAddsUp(t *testing.T) {",
      "\tif got := Add(1, 2); got != 3 {",
      '\t\tt.Fatalf("Add(1,2) = %d, want 3", got)',
      "\t}",
      "}",
      "",
    ].join("\n"),
  );
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "init"]);
  return dir;
}

// Full-file hunks over calc/calc.go — deterministic to apply.
const header = "diff --git a/calc/calc.go b/calc/calc.go\n--- a/calc/calc.go\n+++ b/calc/calc.go\n";
function diffBody(newReturn: string): string {
  return (
    header +
    "@@ -1,5 +1,5 @@\n" +
    " package calc\n" +
    " \n" +
    " func Add(a, b int) int {\n" +
    "-\treturn a + b\n" +
    `+\t${newReturn}\n` +
    " }\n"
  );
}
// a-b: TestAlwaysOk still passes (0), TestAddsUp fails (Add(1,2) = -1).
const BREAK = diffBody("return a - b");
// benign: both tests still pass.
const BENIGN = diffBody("return a + b + 0");
// a compile error: `bogus` is undefined — the go build fails, which IS the executed result.
const COMPILE_BREAK = diffBody("return a + bogus");

let dir: string;
beforeAll(async () => {
  await initGraphScanners();
});
beforeEach(() => {
  resetGraphCache();
  dir = makeRepo();
  // git init + two commits is normally instant, but on a loaded CI runner it has exceeded vitest's
  // default 10s hook timeout. The hook isn't what's under test; give it room.
}, 60_000);
afterEach(() => rmDir(dir));

describe("go runner — unavailable path (always)", () => {
  it("reports runner-unavailable when the go toolchain can't run, and still selects the tests", async () => {
    // Shadow `go` with a shim that exits non-zero, so `go version` fails deterministically
    // regardless of whether the host has a real go. git still resolves further down PATH.
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-goshim-"));
    writeFailingShim(shimDir, "go");
    const oldPath = process.env["PATH"];
    process.env["PATH"] = shimDir + path.delimiter + (oldPath ?? "");
    try {
      const pf = await preflight(dir, { diff: BREAK });
      if ("error" in pf) throw new Error(pf.error);
      expect(pf.executed.status).toBe("runner-unavailable");
      expect(pf.executed.runner).toBe("go");
      expect(pf.executed.error).toMatch(/go toolchain is not available/);
      expect(pf.testsSelected).toEqual(["calc/calc_test.go"]); // selection still works
    } finally {
      process.env["PATH"] = oldPath;
      rmDir(shimDir);
    }
  }, 30_000);
});

describe.skipIf(!GO)("go runner — executed path (host go)", () => {
  it("runs the package, reports the passing and failing test, with a graph path to the change", async () => {
    const pf = await preflight(dir, { diff: BREAK });
    if ("error" in pf) throw new Error(pf.error);
    expect(pf.executed.status).toBe("failed");
    expect(pf.executed.runner).toBe("go");
    expect(pf.executed.passed).toBeGreaterThanOrEqual(1); // TestAlwaysOk
    expect(pf.executed.failed).toBeGreaterThanOrEqual(1); // TestAddsUp
    const failure = pf.executed.failures.find((f) => f.test === "TestAddsUp");
    expect(failure).toBeDefined();
    expect(failure!.file).toBe("calc/calc_test.go");
    expect(failure!.graphPath).toEqual(["calc/calc_test.go", "calc/calc.go"]);
    expect(`${failure!.message}\n${failure!.trace ?? ""}`).toContain("want 3");
  }, 300_000);

  it("passes a benign change", async () => {
    const pf = await preflight(dir, { diff: BENIGN });
    if ("error" in pf) throw new Error(pf.error);
    expect(pf.executed.status).toBe("passed");
    expect(pf.executed.passed).toBeGreaterThanOrEqual(2);
    expect(pf.executed.failed).toBe(0);
  }, 300_000);

  it("surfaces a compile error as an executed failure carrying the compiler output", async () => {
    const pf = await preflight(dir, { diff: COMPILE_BREAK });
    if ("error" in pf) throw new Error(pf.error);
    // go builds before it tests, so the build failure IS the result — a failure, not a crash.
    expect(pf.executed.status).toBe("failed");
    expect(pf.executed.runner).toBe("go");
    const evidence = `${pf.executed.output ?? ""}\n${pf.executed.failures.map((f) => `${f.message}\n${f.trace ?? ""}`).join("\n")}`;
    expect(evidence).toContain("bogus"); // the undefined identifier from the compiler
  }, 300_000);

  it("reports environment-error (not runner-unavailable) when the toolchain can't be resolved", async () => {
    // go exists, but go.mod demands a version this toolchain can't become under GOTOOLCHAIN=local —
    // that's an environment fault (a real repo would try to download and might fail offline), not a
    // missing runner or a test failure. Rewrite go.mod to require an impossible version.
    fs.writeFileSync(path.join(dir, "go.mod"), "module example.com/app\n\ngo 1.99\n");
    execFileSync("git", ["commit", "-qam", "bump"], {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_NAME: "D", GIT_AUTHOR_EMAIL: "d@e.com", GIT_COMMITTER_NAME: "D", GIT_COMMITTER_EMAIL: "d@e.com" },
    });
    const prev = process.env["GOTOOLCHAIN"];
    process.env["GOTOOLCHAIN"] = "local"; // never attempt a download — fail fast and deterministically
    try {
      const pf = await preflight(dir, { diff: BENIGN });
      if ("error" in pf) throw new Error(pf.error);
      expect(pf.executed.status).toBe("environment-error");
      expect(pf.executed.runner).toBe("go");
      expect(pf.executed.error).toMatch(/go toolchain could not be prepared/);
      expect(pf.executed.failed ?? 0).toBe(0); // no test or build failure — the run never got there
    } finally {
      if (prev === undefined) delete process.env["GOTOOLCHAIN"];
      else process.env["GOTOOLCHAIN"] = prev;
    }
  }, 300_000);
});
