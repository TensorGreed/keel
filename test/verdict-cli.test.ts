import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The Stop-hook reads its payload from fd 0 (fs.readFileSync(0)). ESM namespaces can't be
// spied, so we mock node:fs and only divert fd-0 reads when a test opts in via hooked.stdin.
const hooked = vi.hoisted(() => ({ stdin: null as string | null }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    readFileSync: (p: unknown, ...rest: unknown[]) =>
      p === 0 && hooked.stdin !== null ? hooked.stdin : (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest),
  };
});

import { resetGraphCache } from "../src/graph/cache.js";
import { runVerdict } from "../src/trust/verdict-cli.js";

// `keel verdict` end-to-end: the same trust-layer computation as the MCP tool, driven from
// the CLI the way a CI check or a Claude Code hook drives it. Exit codes: 0 pass/warn, 2 block,
// 1 error. --json prints the full verdict; --hook speaks the Stop-hook control protocol.

function git(dir: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "D", GIT_AUTHOR_EMAIL: "d@e.com",
      GIT_COMMITTER_NAME: "D", GIT_COMMITTER_EMAIL: "d@e.com",
      GIT_AUTHOR_DATE: "2021-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2021-01-01T00:00:00Z",
    },
  });
}
function write(dir: string, rel: string, contents: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), contents);
}

const BENIGN = `diff --git a/sum.js b/sum.js\n--- a/sum.js\n+++ b/sum.js\n@@ -1 +1 @@\n-exports.sum = (a, b) => a + b;\n+exports.sum = (a, b) => a + b + 0;\n`;
const BREAKING = `diff --git a/sum.js b/sum.js\n--- a/sum.js\n+++ b/sum.js\n@@ -1 +1 @@\n-exports.sum = (a, b) => a + b;\n+exports.sum = (a, b) => a - b;\n`;

describe("runVerdict (keel verdict CLI)", () => {
  let dir: string;
  let out: string[];
  let err: string[];
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  const diffPath = (name: string): string => path.join(dir, name);

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-verdict-cli-"));
    git(dir, ["init", "-b", "main"]);
    write(dir, ".gitignore", ".keel/\n");
    write(dir, "package.json", JSON.stringify({ name: "v", version: "1.0.0" }) + "\n");
    write(dir, "sum.js", "exports.sum = (a, b) => a + b;\n");
    write(dir, "sum.test.js", 'const test = require("node:test");\nconst assert = require("node:assert");\nconst { sum } = require("./sum.js");\ntest("adds", () => assert.strictEqual(sum(2, 3), 5));\n');
    fs.writeFileSync(diffPath("benign.diff"), BENIGN);
    fs.writeFileSync(diffPath("breaking.diff"), BREAKING);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "init"]);
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetGraphCache();
    process.env["KEEL_REPO"] = dir;
    out = [];
    err = [];
    outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => { out.push(String(chunk)); return true; });
    errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { err.push(String(chunk)); return true; });
    logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ") + "\n"); });
  });
  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
    logSpy.mockRestore();
    delete process.env["KEEL_REPO"];
    vi.restoreAllMocks();
  });

  it("exits 0 and prints a PASS summary for a benign change", async () => {
    const code = await runVerdict(["--diff-file", diffPath("benign.diff")]);
    expect(code).toBe(0);
    expect(err.join("")).toContain("verdict: PASS");
  }, 30_000);

  it("exits 2 and prints a BLOCK summary for a change that breaks the tests", async () => {
    const code = await runVerdict(["--diff-file", diffPath("breaking.diff")]);
    expect(code).toBe(2);
    expect(err.join("")).toContain("verdict: BLOCK");
  }, 30_000);

  it("--json emits the full machine-readable verdict on stdout", async () => {
    const code = await runVerdict(["--json", "--diff-file", diffPath("breaking.diff")]);
    expect(code).toBe(2);
    const parsed = JSON.parse(out.join("")) as { verdict: string; reasons: { rule: string; outcome: string }[] };
    expect(parsed.verdict).toBe("block");
    expect(parsed.reasons.some((r) => r.rule === "requireSimPass" && r.outcome === "block")).toBe(true);
  }, 30_000);

  it("--hook emits the Stop-hook block control JSON on a failing verdict", async () => {
    const wasTTY = process.stdin.isTTY;
    (process.stdin as { isTTY?: boolean }).isTTY = true; // no hook payload piped in this run
    try {
      const code = await runVerdict(["--hook", "--diff-file", diffPath("breaking.diff")]);
      expect(code).toBe(2);
      const control = JSON.parse(out.join("")) as { decision: string; reason: string };
      expect(control.decision).toBe("block");
      expect(control.reason).toContain("keel verdict: BLOCK");
    } finally {
      (process.stdin as { isTTY?: boolean }).isTTY = wasTTY;
    }
  }, 30_000);

  it("--hook stays silent (allows the stop) on a passing verdict", async () => {
    const wasTTY = process.stdin.isTTY;
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    try {
      const code = await runVerdict(["--hook", "--diff-file", diffPath("benign.diff")]);
      expect(code).toBe(0);
      expect(out.join("")).toBe(""); // empty stdout = let the agent finish
    } finally {
      (process.stdin as { isTTY?: boolean }).isTTY = wasTTY;
    }
  }, 30_000);

  it("--hook honors stop_hook_active: allows the stop without running the sim", async () => {
    const wasTTY = process.stdin.isTTY;
    (process.stdin as { isTTY?: boolean }).isTTY = false; // pretend a hook piped a payload
    hooked.stdin = '{"hook_event_name":"Stop","stop_hook_active":true}';
    try {
      // A breaking diff would normally block — but stop_hook_active must short-circuit to allow.
      const code = await runVerdict(["--hook", "--diff-file", diffPath("breaking.diff")]);
      expect(code).toBe(0);
      expect(out.join("")).toBe("");
    } finally {
      hooked.stdin = null;
      (process.stdin as { isTTY?: boolean }).isTTY = wasTTY;
    }
  });

  it("exits 1 on an unknown flag", async () => {
    const code = await runVerdict(["--nope"]);
    expect(code).toBe(1);
    expect(err.join("")).toContain("unexpected argument");
  });

  it("exits 1 when --diff-file points at a missing file", async () => {
    const code = await runVerdict(["--diff-file", path.join(dir, "does-not-exist.diff")]);
    expect(code).toBe(1);
    expect(err.join("")).toContain("cannot read");
  });

  it("prints help and exits 0 for --help", async () => {
    const code = await runVerdict(["--help"]);
    expect(code).toBe(0);
    expect(out.join("")).toContain("keel verdict");
  });

  it("--github-check without a token errors (exit 1) on an otherwise-passing verdict", async () => {
    const hadToken = process.env["GITHUB_TOKEN"];
    delete process.env["GITHUB_TOKEN"];
    try {
      const code = await runVerdict(["--github-check", "--diff-file", diffPath("benign.diff")]);
      expect(code).toBe(1); // the requested publish failed, so the run is an error
      expect(err.join("")).toContain("github check: no GITHUB_TOKEN");
    } finally {
      if (hadToken !== undefined) process.env["GITHUB_TOKEN"] = hadToken;
    }
  }, 30_000);

  it("--github-check lets a block outrank a publish failure (exit 2)", async () => {
    const hadToken = process.env["GITHUB_TOKEN"];
    delete process.env["GITHUB_TOKEN"];
    try {
      const code = await runVerdict(["--github-check", "--diff-file", diffPath("breaking.diff")]);
      expect(code).toBe(2); // block dominates the publish error
      expect(err.join("")).toContain("verdict: BLOCK");
    } finally {
      if (hadToken !== undefined) process.env["GITHUB_TOKEN"] = hadToken;
    }
  }, 30_000);
});
