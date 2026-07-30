import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteEventStore } from "../src/events/sqlite-store.js";
import { ciRunEvent } from "../src/ci/ingest.js";
import { computeVerdict, type Verdict } from "../src/trust/verdict.js";
import { resetGraphCache } from "../src/graph/cache.js";
import { linkNodeModules, rmDir } from "./helpers/platform.js";

// End-to-end flywheel: CI history says "sum adds" is flaky; a real sim failure of that same test
// is discounted by the verdict (warn, not block). Without the CI history, it blocks.

const KEEL_NODE_MODULES = path.resolve(__dirname, "..", "node_modules");

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
function ok(v: Verdict | { error: string }): Verdict {
  if ("error" in v) throw new Error(v.error);
  return v;
}

const BREAK_SUM = `diff --git a/sum.ts b/sum.ts
--- a/sum.ts
+++ b/sum.ts
@@ -1 +1 @@
-export const sum = (a: number, b: number): number => a + b;
+export const sum = (a: number, b: number): number => a - b;
`;

describe("flaky discounting, end to end", () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-flaky-"));
    git(dir, ["init", "-b", "main"]);
    write(dir, ".gitignore", "node_modules/\n.keel/\n");
    write(dir, "package.json", JSON.stringify({ name: "fv", version: "1.0.0", type: "module", devDependencies: { vitest: "*" } }) + "\n");
    write(dir, "sum.ts", "export const sum = (a: number, b: number): number => a + b;\n");
    write(dir, "sum.test.ts", 'import { test, expect } from "vitest";\nimport { sum } from "./sum.js";\ntest("sum adds", () => {\n  expect(sum(2, 3)).toBe(5);\n});\n');
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "init"]);
    linkNodeModules(KEEL_NODE_MODULES, dir); // share keel's vitest
  });
  afterAll(() => rmDir(dir));
  beforeEach(() => resetGraphCache());

  it("blocks the failing change when there is no flaky history", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      const v = ok(await computeVerdict(dir, store, { diff: BREAK_SUM }));
      expect(v.facts.sim.status).toBe("failed");
      expect(v.verdict).toBe("block");
      expect(v.reasons.some((r) => r.rule === "requireSimPass" && r.outcome === "block")).toBe(true);
    } finally {
      store.close();
    }
  }, 60_000);

  it("discounts the same failure to a warn once CI has proven it flaky", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      // Same commit "c1" seen twice with opposite outcomes for "sum adds" -> flaky.
      await store.append(ciRunEvent("run-a", "c1", "2021-05-01T00:00:00Z", [{ name: "sum adds", file: "sum.test.ts", status: "passed" }]));
      await store.append(ciRunEvent("run-b", "c1", "2021-05-01T01:00:00Z", [{ name: "sum adds", file: "sum.test.ts", status: "failed" }]));

      const v = ok(await computeVerdict(dir, store, { diff: BREAK_SUM }));
      expect(v.facts.sim.status).toBe("failed");
      expect(v.facts.sim.failures.find((f) => f.file === "sum.test.ts")?.flaky).toBe(true);
      expect(v.verdict).toBe("warn"); // discounted, not blocked
      expect(v.reasons.find((r) => r.rule === "sim")?.detail).toMatch(/known-flaky/);
    } finally {
      store.close();
    }
  }, 60_000);
});
