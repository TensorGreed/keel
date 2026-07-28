import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetGraphCache } from "../src/graph/cache.js";
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
    const parsed = JSON.parse(out.join("")) as { ruleCount: number; violations: { from: string; to: string }[] };
    expect(parsed.ruleCount).toBe(1);
    expect(parsed.violations).toHaveLength(1);
    expect(parsed.violations[0]).toMatchObject({ from: "src/ui/page.ts", to: "src/db/client.ts" });
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

  it("exits 1 when --arch is missing", async () => {
    expect(await runReport([])).toBe(1);
    expect(err.join("")).toMatch(/--arch/);
  });
});
