import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetGraphCache } from "../src/graph/cache.js";
import { SqliteEventStore } from "../src/events/sqlite-store.js";
import { runReport } from "../src/trust/report-cli.js";

// `keel report --arch` over a real (non-git is fine) repo directory: loadGraph builds the graph
// from disk, so we just need files + a policy. Output goes to stderr (human) / stdout (--json).

let dir: string;
let out: string[];
let err: string[];
let outSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

function write(rel: string, contents: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), contents);
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

/** Seed commit events into the report's event log (the dir isn't git, so nothing overwrites them). */
function seedCommits(commits: { sha: string; date: string; files: string[] }[]): void {
  const store = new SqliteEventStore(path.join(dir, ".keel", "events.db"));
  store.appendMany(commits.map((c) => ({ kind: "commit", externalId: c.sha, occurredAt: c.date, actor: "alice", title: "c", payload: {}, files: c.files })));
  store.close();
}

beforeEach(() => {
  resetGraphCache();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-report-"));
  process.env["KEEL_REPO"] = dir;
  write("tsconfig.json", JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", allowJs: true } }));
  write("src/db/client.ts", "export const q = 1;\n");
  write("src/ui/page.ts", 'import { q } from "../db/client.js";\nexport const page = q;\n');
  out = [];
  err = [];
  outSpy = vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => { out.push(String(c)); return true; });
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => { err.push(String(c)); return true; });
  logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ") + "\n"); });
});
afterEach(() => {
  outSpy.mockRestore();
  errSpy.mockRestore();
  logSpy.mockRestore();
  delete process.env["KEEL_REPO"];
  fs.rmSync(dir, { recursive: true, force: true });
});

const RULE = JSON.stringify({ version: 1, forbiddenImports: [{ from: "src/ui/**", to: "src/db/**", reason: "layering" }] });

describe("keel report --arch", () => {
  it("lists repo-wide violations and exits 0 (informational)", async () => {
    write("keel.policy.json", RULE);
    const code = await runReport(["--arch"]);
    expect(code).toBe(0);
    expect(err.join("")).toContain("src/ui/page.ts → src/db/client.ts");
  });

  it("--json emits the violations with a rule count", async () => {
    write("keel.policy.json", RULE);
    const code = await runReport(["--arch", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("")) as { arch: { ruleCount: number; violations: { from: string; to: string }[] } };
    expect(parsed.arch.ruleCount).toBe(1);
    expect(parsed.arch.violations).toHaveLength(1);
    expect(parsed.arch.violations[0]).toMatchObject({ from: "src/ui/page.ts", to: "src/db/client.ts" });
  });

  it("reports a clean repo when no edge violates", async () => {
    write("keel.policy.json", JSON.stringify({ version: 1, forbiddenImports: [{ from: "src/api/**", to: "src/db/**", reason: "x" }] }));
    const code = await runReport(["--arch"]);
    expect(code).toBe(0);
    expect(err.join("")).toMatch(/clean/);
  });

  it("says nothing to report when no rules are configured", async () => {
    write("keel.policy.json", JSON.stringify({ version: 1 }));
    const code = await runReport(["--arch"]);
    expect(code).toBe(0);
    expect(err.join("")).toMatch(/no forbiddenImports rules/);
  });

  it("errors on a malformed policy", async () => {
    write("keel.policy.json", "{ not json");
    expect(await runReport(["--arch"])).toBe(1);
  });
});

describe("keel report --hotspots", () => {
  it("ranks files by churn × blast radius × coverage gap, showing components", async () => {
    seedCommits([
      { sha: "1", date: daysAgo(1), files: ["src/ui/page.ts"] },
      { sha: "2", date: daysAgo(2), files: ["src/ui/page.ts"] },
      { sha: "3", date: daysAgo(3), files: ["src/ui/page.ts"] }, // page.ts: 3 commits, blast 0, uncovered -> 3*1*2=6
      { sha: "4", date: daysAgo(1), files: ["src/db/client.ts"] }, // client.ts: 1 commit, blast 1, uncovered -> 1*2*2=4
    ]);
    const code = await runReport(["--hotspots", "--json"]);
    expect(code).toBe(0);
    const j = JSON.parse(out.join("")) as { hotspots: { days: number; files: { path: string; commits: number; blastRadius: number; covered: boolean; score: number }[] } };
    expect(j.hotspots.files.map((f) => f.path)).toEqual(["src/ui/page.ts", "src/db/client.ts"]);
    const page = j.hotspots.files[0]!;
    expect(page).toMatchObject({ commits: 3, blastRadius: 0, covered: false, score: 6 });
  });

  it("respects the --days window", async () => {
    seedCommits([
      { sha: "recent", date: daysAgo(5), files: ["src/ui/page.ts"] },
      { sha: "old", date: daysAgo(200), files: ["src/db/client.ts"] }, // outside a 90-day window
    ]);
    const code = await runReport(["--hotspots", "--days", "90", "--json"]);
    expect(code).toBe(0);
    const j = JSON.parse(out.join("")) as { hotspots: { files: { path: string }[] } };
    expect(j.hotspots.files.map((f) => f.path)).toEqual(["src/ui/page.ts"]); // old client.ts commit excluded
  });

  it("reports nothing to rank when no commits fall in the window", async () => {
    const code = await runReport(["--hotspots"]);
    expect(code).toBe(0);
    expect(err.join("")).toMatch(/no files changed/);
  });
});

describe("keel report (no flags)", () => {
  it("prints both the arch and hotspots sections", async () => {
    write("keel.policy.json", RULE);
    seedCommits([{ sha: "1", date: daysAgo(1), files: ["src/ui/page.ts"] }]);
    const code = await runReport([]);
    expect(code).toBe(0);
    const text = err.join("");
    expect(text).toMatch(/arch:/);
    expect(text).toMatch(/hotspots:/);
  });
});
