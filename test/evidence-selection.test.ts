/**
 * The fault-injection harness — `keel evidence`.
 *
 * The whole point of this harness is to produce a number nobody has to take on faith, which puts a
 * hard requirement on the tests: **prove it can detect an escape.** A harness that always reports
 * 0% because it is broken is strictly worse than no harness, because it manufactures confidence.
 * So the load-bearing test here is a NEGATIVE control — a repo rigged so that a real failure is
 * guaranteed to fall outside keel's selection — and it asserts the harness catches keel out.
 *
 * The rigging is not artificial, either. A test that requires its subject through a computed path
 * is invisible to import-reachability selection, which is exactly the blind spot this measurement
 * exists to quantify. The escape it produces is a real one.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetGraphCache } from "../src/graph/cache.js";
import { initGraphScanners } from "../src/graph/scanners.js";
import { measureSelection } from "../src/evidence/selection.js";
import { mutate, mutationSites, sequence } from "../src/evidence/mutate.js";
import { renderSelectionEvidence } from "../src/evidence/report.js";
import { rmDir } from "./helpers/platform.js";

let dir: string;

function git(args: string[]): void {
  execFileSync("git", args, {
    cwd: dir,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e.com",
      GIT_AUTHOR_DATE: "2021-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2021-01-01T00:00:00Z",
    },
  });
}

function write(rel: string, contents: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
}

/**
 * A repo whose only mutable site is `a === 0` in calc.js, and whose suite definitely notices when
 * it flips. `visible.test.js` imports calc normally, so keel selects it.
 */
function makeRepo(): void {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-evidence-"));
  write(".gitignore", "node_modules/\n.keel/\n");
  write("package.json", `${JSON.stringify({ name: "evidence-fixture", version: "1.0.0", private: true, type: "commonjs" }, null, 2)}\n`);
  write("src/calc.js", "exports.classify = (a) => {\n  if (a === 0) return \"zero\";\n  return \"other\";\n};\n");
  write(
    "src/visible.test.js",
    'const { test } = require("node:test");\nconst assert = require("node:assert");\nconst { classify } = require("./calc.js");\ntest("visible sees zero", () => {\n  assert.equal(classify(0), "zero");\n});\n',
  );
}

beforeAll(async () => {
  await initGraphScanners();
});
beforeEach(() => {
  resetGraphCache();
  makeRepo();
});
afterEach(() => rmDir(dir));

describe("mutation generation", () => {
  it("swaps an operator for one of the same shape, leaving the file parseable", () => {
    const source = "const ok = a === b;\n";
    const m = mutate("x.ts", source, 0)!;
    expect(m.from).toBe("===");
    expect(m.to).toBe("!==");
    expect(m.mutated).toBe("const ok = a !== b;\n");
    expect(m.line).toBe(1);
  });

  it("never mistakes `===` for `==` with a stray `=`", () => {
    // A textual swap that got this wrong would produce `a !== = b` and take down the whole suite.
    const sites = mutationSites("const ok = a === b;\n");
    expect(sites).toHaveLength(1);
    expect(sites[0]!.from).toBe("===");
  });

  it("leaves comments, imports and bare string literals alone", () => {
    expect(mutationSites("// a === b\n")).toEqual([]);
    expect(mutationSites("# a == b\n")).toEqual([]);
    expect(mutationSites('import { x } from "./y.js"; // a === b\n')).toEqual([]);
    expect(mutationSites('  "some === message",\n')).toEqual([]);
  });

  it("returns null for a file with nothing safe to change, rather than inventing a fault", () => {
    expect(mutate("x.ts", "export const name = 'keel';\n", 0)).toBeNull();
  });

  it("is deterministic: the same index always yields the same fault", () => {
    const source = "const a = x === y;\nconst b = p || q;\nconst c = true;\n";
    for (const index of [0, 1, 2, 7]) {
      expect(mutate("f.ts", source, index)).toEqual(mutate("f.ts", source, index));
    }
    // …and different indexes reach different sites, or the harness would test one line forever.
    expect(new Set([0, 1, 2].map((i) => mutate("f.ts", source, i)!.line)).size).toBe(3);
  });

  it("produces the same sequence from the same seed, and a different one otherwise", () => {
    const take = (seed: number): number[] => {
      const next = sequence(seed);
      return [next(), next(), next()];
    };
    expect(take(1)).toEqual(take(1));
    expect(take(1)).not.toEqual(take(2));
  });
});

describe("the harness measures selection", () => {
  it("reports `caught` when every failing test was one keel selected", async () => {
    git(["init", "-b", "main"]);
    git(["add", "-A"]);
    git(["commit", "-qm", "init"]);

    const result = await measureSelection(dir, { trials: 1, seed: 1, timeoutMs: 120_000 });
    if ("error" in result) throw new Error(result.error);

    expect(result.trials).toHaveLength(1);
    const [trial] = result.trials;
    expect(trial!.outcome, JSON.stringify(trial)).toBe("caught");
    expect(trial!.mutation).toEqual({ line: 2, from: "===", to: "!==" });
    expect(trial!.failed).toEqual(["src/visible.test.js"]);
    expect(trial!.escapes).toEqual([]);
    expect(result.summary.escapeRate).toBe(0);
    expect(result.summary.measured).toBe(1);
  }, 300_000);

  it("DETECTS AN ESCAPE — the negative control this whole harness rests on", async () => {
    // A test that requires its subject through a computed path is invisible to import-reachability
    // selection. keel will not select it, it will still fail, and the harness must say so. If this
    // ever passes as "caught", the 0% escape rates elsewhere mean nothing.
    write(
      "src/hidden.test.js",
      'const { test } = require("node:test");\nconst assert = require("node:assert");\nconst name = "calc";\nconst { classify } = require("./" + name + ".js");\ntest("hidden also sees zero", () => {\n  assert.equal(classify(0), "zero");\n});\n',
    );
    git(["init", "-b", "main"]);
    git(["add", "-A"]);
    git(["commit", "-qm", "init"]);

    const result = await measureSelection(dir, { trials: 1, seed: 1, timeoutMs: 120_000 });
    if ("error" in result) throw new Error(result.error);

    const [trial] = result.trials;
    expect(trial!.outcome, `expected an escape, got ${JSON.stringify(trial)}`).toBe("escaped");
    expect(trial!.escapes).toEqual(["src/hidden.test.js"]);
    expect(trial!.failed).toContain("src/visible.test.js"); // the selected one failed too
    expect(result.summary.escaped).toBe(1);
    expect(result.summary.escapeRate).toBe(1);

    // And the report must lead with it rather than burying it under the selectivity win.
    const text = renderSelectionEvidence(result);
    expect(text).toContain("ESCAPE RATE 100.0%");
    expect(text).toContain("preflight would have reported green on a real break");
    expect(text).toContain("Discount this entirely until the escape rate is zero");
  }, 300_000);

  it("counts a fault the suite never noticed as `undetected`, not as a keel success", async () => {
    // Uncovered code: mutating it proves nothing about selection either way, so it must not inflate
    // the caught count — the denominator has to stay honest.
    write("src/lonely.js", "exports.unused = (a) => (a === 1 ? 1 : 2);\n");
    git(["init", "-b", "main"]);
    git(["add", "-A"]);
    git(["commit", "-qm", "init"]);

    const result = await measureSelection(dir, { trials: 4, seed: 3, timeoutMs: 120_000, include: ["src/"] });
    if ("error" in result) throw new Error(result.error);

    // lonely.js is reachable from no test, so it is never even a candidate.
    expect(result.trials.map((t) => t.file)).not.toContain("src/lonely.js");
    expect(result.summary.caught + result.summary.escaped).toBe(result.summary.measured);
  }, 600_000);

  it("refuses to guess when there is no suite to measure against", async () => {
    fs.rmSync(path.join(dir, "src", "visible.test.js"));
    git(["init", "-b", "main"]);
    git(["add", "-A"]);
    git(["commit", "-qm", "init"]);

    expect(await measureSelection(dir, { trials: 1 })).toEqual({ error: expect.stringContaining("no test files in the graph") });
  }, 120_000);

  it("leaves the working tree exactly as it found it", async () => {
    git(["init", "-b", "main"]);
    git(["add", "-A"]);
    git(["commit", "-qm", "init"]);
    const before = fs.readFileSync(path.join(dir, "src/calc.js"), "utf8");

    await measureSelection(dir, { trials: 2, seed: 5, timeoutMs: 120_000 });

    expect(fs.readFileSync(path.join(dir, "src/calc.js"), "utf8")).toBe(before);
    // No stray worktree registration left behind either.
    const worktrees = execFileSync("git", ["worktree", "list"], { cwd: dir, encoding: "utf8" });
    expect(worktrees.trim().split("\n")).toHaveLength(1);
  }, 600_000);
});
