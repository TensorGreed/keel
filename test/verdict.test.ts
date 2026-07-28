import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteEventStore } from "../src/events/sqlite-store.js";
import type { VerdictFacts } from "../src/trust/facts.js";
import { DEFAULT_POLICY, type Policy } from "../src/trust/policy.js";
import { computeVerdict, evaluatePolicy, type Verdict } from "../src/trust/verdict.js";
import { resetGraphCache } from "../src/graph/cache.js";

// --- rule matrix (pure, fabricated facts) -----------------------------------

function facts(over: Partial<VerdictFacts> = {}): VerdictFacts {
  return {
    changedFiles: [{ path: "a.ts", status: "modified", inGraph: true }],
    blastRadius: 2,
    impacted: ["b.ts", "c.ts"],
    narrowedRadius: 1,
    sim: { status: "passed", passed: 3, failed: 0, failures: [], budget: { maxTests: 50, maxSeconds: 120, testsSkipped: [], truncated: false } },
    uncoveredChanges: [],
    testsSelected: ["a.test.ts"],
    relevantDecisions: [],
    hasHumanDecision: false,
    forbiddenImports: [],
    foreignChanges: [],
    ...over,
  };
}

function policy(over: Partial<Policy> = {}): Policy {
  return { ...DEFAULT_POLICY, ...over };
}

const failedSim = (): VerdictFacts["sim"] => ({
  status: "failed",
  passed: 1,
  failed: 1,
  failures: [{ test: "adds", file: "a.test.ts", message: "expected 5 got -1" }],
  budget: { maxTests: 50, maxSeconds: 120, testsSkipped: [], truncated: false },
});

function reasonFor(v: { reasons: { rule: string }[] }, rule: string) {
  return v.reasons.find((r) => r.rule === rule);
}

describe("evaluatePolicy", () => {
  it("passes when every configured rule is affirmatively satisfied", () => {
    const v = evaluatePolicy(facts(), policy());
    expect(v.verdict).toBe("pass");
    expect(reasonFor(v, "requireSimPass")).toMatchObject({ outcome: "pass" });
  });

  it("blocks on test failures when requireSimPass is on, naming the failing tests", () => {
    const v = evaluatePolicy(facts({ sim: failedSim() }), policy({ requireSimPass: true }));
    expect(v.verdict).toBe("block");
    expect(reasonFor(v, "requireSimPass")).toMatchObject({ outcome: "block" });
    expect(reasonFor(v, "requireSimPass")!.detail).toContain("adds");
  });

  it("only warns on failures when requireSimPass is off", () => {
    const v = evaluatePolicy(facts({ sim: failedSim() }), policy({ requireSimPass: false }));
    expect(v.verdict).toBe("warn");
    expect(reasonFor(v, "sim")).toMatchObject({ outcome: "warn" });
  });

  it("discounts a run whose only failures are known-flaky (warn, not block)", () => {
    const sim = { ...failedSim(), failures: [{ test: "flaps", file: "f.test.ts", message: "x", flaky: true }] };
    const v = evaluatePolicy(facts({ sim }), policy({ requireSimPass: true }));
    expect(v.verdict).toBe("warn");
    expect(reasonFor(v, "sim")!.outcome).toBe("warn");
    expect(reasonFor(v, "sim")!.detail).toMatch(/known-flaky/);
  });

  it("still blocks on a real failure, noting the flaky ones were discounted", () => {
    const sim = {
      ...failedSim(),
      failures: [
        { test: "real", file: "r.test.ts", message: "x" },
        { test: "flaps", file: "f.test.ts", message: "y", flaky: true },
      ],
    };
    const v = evaluatePolicy(facts({ sim }), policy({ requireSimPass: true }));
    expect(v.verdict).toBe("block");
    const r = reasonFor(v, "requireSimPass")!;
    expect(r.outcome).toBe("block");
    expect(r.detail).toContain("real");
    expect(r.detail).toMatch(/1 known-flaky failure\(s\) discounted/);
  });

  it("blocks with the status when the sim could not run, regardless of requireSimPass", () => {
    const sim = { ...facts().sim, status: "apply-failed" as const, error: "git apply failed: patch does not apply" };
    const v = evaluatePolicy(facts({ sim }), policy({ requireSimPass: false }));
    expect(v.verdict).toBe("block");
    expect(reasonFor(v, "sim")).toMatchObject({ outcome: "block" });
    expect(reasonFor(v, "sim")!.detail).toContain("apply-failed");
  });

  it("blocks when a changed path matches a protected glob, naming file/glob/reason", () => {
    const p = policy({ protectedPaths: [{ glob: "src/auth/**", reason: "security-critical" }] });
    const v = evaluatePolicy(facts({ changedFiles: [{ path: "src/auth/token.ts", status: "modified", inGraph: true }] }), p);
    expect(v.verdict).toBe("block");
    const r = reasonFor(v, "protectedPaths")!;
    expect(r.outcome).toBe("block");
    expect(r.detail).toContain("src/auth/token.ts");
    expect(r.detail).toContain("security-critical");
  });

  it("emits an affirmative pass when protected paths are configured but untouched", () => {
    const p = policy({ protectedPaths: [{ glob: "src/auth/**", reason: "security" }] });
    const v = evaluatePolicy(facts(), p);
    expect(v.verdict).toBe("pass");
    expect(reasonFor(v, "protectedPaths")).toMatchObject({ outcome: "pass" });
  });

  it("blocks when the blast radius exceeds the cap", () => {
    const v = evaluatePolicy(facts({ blastRadius: 5 }), policy({ maxBlastRadius: 3 }));
    expect(v.verdict).toBe("block");
    expect(reasonFor(v, "maxBlastRadius")!.detail).toContain("5");
  });

  it("blocks on uncovered changes when forbidden", () => {
    const v = evaluatePolicy(facts({ uncoveredChanges: ["x.ts"] }), policy({ forbidUncoveredChanges: true }));
    expect(v.verdict).toBe("block");
    expect(reasonFor(v, "forbidUncoveredChanges")!.detail).toContain("x.ts");
  });

  it("blocks on a truncated sim when forbidden, warns when not", () => {
    const truncated = { ...facts().sim, budget: { maxTests: 1, maxSeconds: 120, testsSkipped: ["b.test.ts"], truncated: true } };
    expect(evaluatePolicy(facts({ sim: truncated }), policy({ forbidTruncatedSim: true })).verdict).toBe("block");

    const warned = evaluatePolicy(facts({ sim: truncated }), policy({ forbidTruncatedSim: false }));
    expect(warned.verdict).toBe("warn");
    expect(reasonFor(warned, "sim")).toMatchObject({ outcome: "warn" });
  });

  it("warns for relevant decisions under requireDecisionReview, flagging human ones", () => {
    const decision = {
      id: "decision:human:1",
      summary: "we chose X",
      rationale: "",
      alternatives: [],
      confidence: "high",
      origin: "human" as const,
      matchReason: "changed (a.ts)",
      source: { pr: null, url: null, author: "carol", date: "2021-01-01T00:00:00Z" },
      files: ["a.ts"],
    };
    const v = evaluatePolicy(facts({ relevantDecisions: [decision], hasHumanDecision: true }), policy({ requireDecisionReview: true }));
    expect(v.verdict).toBe("warn");
    expect(reasonFor(v, "requireDecisionReview")!.detail).toContain("human-recorded");
  });

  it("warns when a change applies cleanly but nothing tests it", () => {
    const noTests = { ...facts().sim, status: "no-tests" as const, passed: undefined, failed: undefined };
    const v = evaluatePolicy(facts({ sim: noTests, testsSelected: [] }), policy());
    expect(v.verdict).toBe("warn");
    expect(reasonFor(v, "coverage")).toMatchObject({ outcome: "warn" });
  });

  it("blocks on a forbidden import edge, naming the exact edge and reason", () => {
    const p = policy({ forbiddenImports: [{ from: "src/ui/**", to: "src/db/**", reason: "layering" }] });
    const violation = { from: "src/ui/page.ts", to: "src/db/client.ts", rule: p.forbiddenImports[0]! };
    const v = evaluatePolicy(facts({ forbiddenImports: [violation] }), p);
    expect(v.verdict).toBe("block");
    const r = reasonFor(v, "forbiddenImports")!;
    expect(r.outcome).toBe("block");
    expect(r.detail).toContain("src/ui/page.ts → src/db/client.ts");
    expect(r.detail).toContain("layering");
  });

  it("passes forbiddenImports affirmatively when rules are set but no edge violates", () => {
    const p = policy({ forbiddenImports: [{ from: "src/ui/**", to: "src/db/**", reason: "layering" }] });
    const v = evaluatePolicy(facts({ forbiddenImports: [] }), p);
    expect(v.verdict).toBe("pass");
    expect(reasonFor(v, "forbiddenImports")).toMatchObject({ outcome: "pass" });
  });

  it("warns on foreign code when the flag is on and a changed file is mostly someone else's", () => {
    const v = evaluatePolicy(facts({ foreignChanges: [{ file: "src/auth.ts", topAuthor: "carol", share: 0.7 }] }), policy({ warnOnForeignCode: true }));
    expect(v.verdict).toBe("warn");
    const r = reasonFor(v, "warnOnForeignCode")!;
    expect(r.outcome).toBe("warn");
    expect(r.detail).toContain("src/auth.ts");
    expect(r.detail).toContain("carol");
  });

  it("passes foreign-code affirmatively when the change stays in the committer's own code", () => {
    const v = evaluatePolicy(facts({ foreignChanges: [] }), policy({ warnOnForeignCode: true }));
    expect(v.verdict).toBe("pass");
    expect(reasonFor(v, "warnOnForeignCode")).toMatchObject({ outcome: "pass" });
  });

  it("lets a block outrank a warn", () => {
    const p = policy({ requireSimPass: true, requireDecisionReview: true });
    const decision = facts().relevantDecisions.concat({
      id: "d1", summary: "s", rationale: "", alternatives: [], confidence: "low", origin: "mined" as const,
      matchReason: "impacted (b.ts)", source: { pr: 1, url: null, author: null, date: "2021-01-01T00:00:00Z" }, files: ["b.ts"],
    });
    const v = evaluatePolicy(facts({ sim: failedSim(), relevantDecisions: decision }), p);
    expect(v.verdict).toBe("block");
  });
});

// --- end to end against a real fixture --------------------------------------

function git(dir: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_NAME: "D", GIT_AUTHOR_EMAIL: "d@e.com", GIT_COMMITTER_NAME: "D", GIT_COMMITTER_EMAIL: "d@e.com", GIT_AUTHOR_DATE: "2021-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2021-01-01T00:00:00Z" },
  });
}
function write(dir: string, rel: string, contents: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), contents);
}
function ok(v: Verdict | { error: string }): Verdict {
  if ("error" in v) throw new Error(v.error);
  return v;
}

const BENIGN = `diff --git a/sum.js b/sum.js\n--- a/sum.js\n+++ b/sum.js\n@@ -1 +1 @@\n-exports.sum = (a, b) => a + b;\n+exports.sum = (a, b) => a + b + 0;\n`;
const BREAKING = `diff --git a/sum.js b/sum.js\n--- a/sum.js\n+++ b/sum.js\n@@ -1 +1 @@\n-exports.sum = (a, b) => a + b;\n+exports.sum = (a, b) => a - b;\n`;

describe("computeVerdict end-to-end", () => {
  let dir: string;
  const store = new SqliteEventStore(":memory:");
  const policyFile = (): string => path.join(dir, "keel.policy.json");

  beforeAll(() => {
    resetGraphCache();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-verdict-"));
    git(dir, ["init", "-b", "main"]);
    write(dir, ".gitignore", ".keel/\n");
    write(dir, "package.json", JSON.stringify({ name: "v", version: "1.0.0" }) + "\n");
    write(dir, "sum.js", "exports.sum = (a, b) => a + b;\n");
    write(dir, "sum.test.js", 'const test = require("node:test");\nconst assert = require("node:assert");\nconst { sum } = require("./sum.js");\ntest("adds", () => assert.strictEqual(sum(2, 3), 5));\n');
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "init"]);
  });
  afterAll(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("passes a benign change under the default policy", async () => {
    resetGraphCache();
    const v = ok(await computeVerdict(dir, store, { diff: BENIGN }));
    expect(v.verdict).toBe("pass");
    expect(v.policy.source).toBe("default");
    expect(v.facts.sim.status).toBe("passed");
  }, 30_000);

  it("blocks a change that breaks the tests", async () => {
    resetGraphCache();
    const v = ok(await computeVerdict(dir, store, { diff: BREAKING }));
    expect(v.verdict).toBe("block");
    expect(v.facts.sim.status).toBe("failed");
    expect(v.reasons.some((r) => r.rule === "requireSimPass" && r.outcome === "block")).toBe(true);
  }, 30_000);

  it("blocks a benign change under a stricter file policy (maxBlastRadius 0)", async () => {
    resetGraphCache();
    fs.writeFileSync(policyFile(), JSON.stringify({ version: 1, maxBlastRadius: 0 }));
    try {
      const v = ok(await computeVerdict(dir, store, { diff: BENIGN }));
      expect(v.verdict).toBe("block");
      expect(v.policy.source).toBe("file");
      expect(v.reasons.some((r) => r.rule === "maxBlastRadius" && r.outcome === "block")).toBe(true);
    } finally {
      fs.rmSync(policyFile(), { force: true });
    }
  }, 30_000);

  it("returns an error for a malformed policy, without running the sim", async () => {
    fs.writeFileSync(policyFile(), "{ not valid");
    try {
      const v = await computeVerdict(dir, store, { diff: BENIGN });
      expect("error" in v).toBe(true);
    } finally {
      fs.rmSync(policyFile(), { force: true });
    }
  });
});

// --- architectural import rules, end to end over a real graph --------------

describe("computeVerdict forbiddenImports end-to-end", () => {
  let dir: string;
  const store = new SqliteEventStore(":memory:");

  beforeAll(() => {
    resetGraphCache();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-arch-"));
    git(dir, ["init", "-b", "main"]);
    write(dir, ".gitignore", ".keel/\n");
    write(dir, "package.json", JSON.stringify({ name: "arch", version: "1.0.0", type: "module" }) + "\n");
    write(dir, "tsconfig.json", JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", allowJs: true } }));
    write(dir, "src/db/client.ts", "export const q = 1;\n");
    write(dir, "src/ui/page.ts", "export const page = 1;\n"); // no db import at HEAD
    write(
      dir,
      "keel.policy.json",
      JSON.stringify({
        version: 1,
        requireSimPass: false,
        forbiddenImports: [{ from: "src/ui/**", to: "src/db/**", reason: "the UI must not import the DB layer directly" }],
      }),
    );
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "init"]);
  });
  afterAll(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("blocks when a changed file introduces a forbidden edge, naming the edge", async () => {
    resetGraphCache();
    // Working-tree change: ui/page.ts now imports the db layer — an introduced forbidden edge.
    fs.writeFileSync(path.join(dir, "src/ui/page.ts"), 'import { q } from "../db/client.js";\nexport const page = q;\n');
    try {
      const v = await computeVerdict(dir, store, {}); // working tree, no explicit diff
      if ("error" in v) throw new Error(v.error);
      expect(v.policy.source).toBe("file");
      expect(v.verdict).toBe("block");
      const r = v.reasons.find((x) => x.rule === "forbiddenImports" && x.outcome === "block");
      expect(r, "expected a forbiddenImports block reason").toBeDefined();
      expect(r!.detail).toContain("src/ui/page.ts → src/db/client.ts");
      expect(v.facts.forbiddenImports).toHaveLength(1);
    } finally {
      fs.writeFileSync(path.join(dir, "src/ui/page.ts"), "export const page = 1;\n");
    }
  }, 30_000);
});
