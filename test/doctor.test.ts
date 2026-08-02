/**
 * `keel doctor` (COMMIT 4). The checker is pure over a gathered DoctorEnv, so each probe is faked by
 * varying one field — covering ok/warn/fail, the exit code, and one named fix per failing line. A
 * final hermetic test drives the real gatherer (with the network probes pointed at dead endpoints)
 * to prove it never throws.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { doctorExitCode, renderDoctorTable, runDoctorChecks, type CheckResult, type DoctorEnv } from "../src/doctor/doctor.js";
import { gatherDoctorEnv } from "../src/doctor/cli.js";
import { rmDir } from "./helpers/platform.js";

function baseEnv(over: Partial<DoctorEnv> = {}): DoctorEnv {
  return {
    root: "/repo",
    nodeVersion: "v24.14.0",
    gitVersion: "git version 2.43.0",
    isRepo: true,
    db: { state: "ok", counts: { commits: 10, prs: 2, decisions: 3 } },
    cache: { state: "fresh", head: "abc1234def5678" },
    graphBuild: { state: "measured", files: 1200, edges: 3400, ms: 400 },
    watch: { supported: true, enabled: true },
    ollama: { reachable: true, models: ["nomic-embed-text:latest", "llama3.2:latest"], required: ["nomic-embed-text", "llama3.2"] },
    github: { state: "valid", remaining: 4999, limit: 5000 },
    runners: [
      { name: "node", available: true },
      { name: "pytest", available: true },
      { name: "go", available: true },
      { name: "mvn", available: true },
      { name: "gradle", available: true },
    ],
    mcpRegistered: true,
    hookInstalled: true,
    ...over,
  };
}

const find = (rs: CheckResult[], name: string): CheckResult => rs.find((r) => r.name === name)!;

describe("runDoctorChecks — all green", () => {
  it("reports every check ok and exits 0", () => {
    const rs = runDoctorChecks(baseEnv());
    expect(rs.every((r) => r.status === "ok")).toBe(true);
    expect(doctorExitCode(rs)).toBe(0);
  });
});

describe("runDoctorChecks — per-probe faults", () => {
  it("fails on an old Node with a version fix", () => {
    const r = find(runDoctorChecks(baseEnv({ nodeVersion: "v20.10.0" })), "Node");
    expect(r.status).toBe("fail");
    expect(r.fix).toMatch(/22\.13/);
  });

  it("fails when git is missing", () => {
    expect(find(runDoctorChecks(baseEnv({ gitVersion: null })), "git").status).toBe("fail");
  });

  it("warns (not fails) outside a git repo", () => {
    expect(find(runDoctorChecks(baseEnv({ isRepo: false })), "Repo").status).toBe("warn");
  });

  it("fails on an unopenable event db, warns when it's merely absent", () => {
    const err = find(runDoctorChecks(baseEnv({ db: { state: "error", error: "file is not a database" } })), "Event log");
    expect(err.status).toBe("fail");
    expect(err.fix).toMatch(/corrupt/i);
    expect(find(runDoctorChecks(baseEnv({ db: { state: "absent" } })), "Event log").status).toBe("warn");
  });

  it("reports the timed graph build, warning only when it exceeds the per-file budget", () => {
    // 1200 files in 400ms = 0.33 ms/file — comfortably inside the 1 ms/file budget.
    const ok = find(runDoctorChecks(baseEnv()), "Graph build");
    expect(ok.status).toBe("ok");
    expect(ok.detail).toMatch(/1200 files, 3400 edges in 0\.4s \(0\.33 ms\/file\)/);

    // Same repo, 20x slower: a monorepo-shaped finding, with the fix naming the cache.
    const slow = find(runDoctorChecks(baseEnv({ graphBuild: { state: "measured", files: 1200, edges: 3400, ms: 8_000 } })), "Graph build");
    expect(slow.status).toBe("warn");
    expect(slow.detail).toMatch(/slower than the 1 ms\/file budget/);
    expect(slow.fix).toMatch(/\.keel\/graph\.json|persist \.keel/);

    // An efficient but enormous repo still warns: the first tool call would feel hung.
    const huge = find(runDoctorChecks(baseEnv({ graphBuild: { state: "measured", files: 400_000, edges: 1, ms: 40_000 } })), "Graph build");
    expect(huge.status).toBe("warn");
    expect(huge.detail).toMatch(/first graph tool call will feel slow/);

    // A SMALL repo is judged by the absolute ceiling alone: below 500 files the per-file rate is
    // dominated by one-time costs (tsconfig, workspace scan), so keel's own 233-file repo at
    // 0.8 ms/file must not read as a finding.
    expect(find(runDoctorChecks(baseEnv({ graphBuild: { state: "measured", files: 233, edges: 505, ms: 185 } })), "Graph build").status).toBe("ok");

    // A build that can't run at all is red — it blocks every graph-backed tool.
    const broken = find(runDoctorChecks(baseEnv({ graphBuild: { state: "error", error: "boom" } })), "Graph build");
    expect(broken.status).toBe("fail");
    expect(broken.detail).toContain("boom");

    // Skipped (--no-graph, or not a repo) is a warning, not a failure, and says which.
    const skipped = find(runDoctorChecks(baseEnv({ graphBuild: { state: "skipped", reason: "--no-graph" } })), "Graph build");
    expect(skipped.status).toBe("warn");
    expect(skipped.detail).toContain("--no-graph");
  });

  it("warns on a stale or absent graph cache", () => {
    expect(find(runDoctorChecks(baseEnv({ cache: { state: "stale", head: "old1234", current: "new5678" } })), "Graph cache").status).toBe("warn");
    expect(find(runDoctorChecks(baseEnv({ cache: { state: "absent" } })), "Graph cache").status).toBe("warn");
  });

  it("handles the Ollama states: ok / missing-model / unreachable", () => {
    expect(find(runDoctorChecks(baseEnv()), "Ollama").status).toBe("ok");
    const missing = find(runDoctorChecks(baseEnv({ ollama: { reachable: true, models: ["nomic-embed-text:latest"], required: ["nomic-embed-text", "llama3.2"] } })), "Ollama");
    expect(missing.status).toBe("warn");
    expect(missing.fix).toMatch(/ollama pull llama3\.2/);
    expect(find(runDoctorChecks(baseEnv({ ollama: { reachable: false, models: [], required: ["nomic-embed-text", "llama3.2"] } })), "Ollama").status).toBe("warn");
  });

  it("handles the GITHUB_TOKEN states: valid / absent / invalid", () => {
    expect(find(runDoctorChecks(baseEnv()), "GITHUB_TOKEN").status).toBe("ok");
    expect(find(runDoctorChecks(baseEnv({ github: { state: "absent" } })), "GITHUB_TOKEN").status).toBe("warn");
    const invalid = find(runDoctorChecks(baseEnv({ github: { state: "invalid", error: "Bad credentials" } })), "GITHUB_TOKEN");
    expect(invalid.status).toBe("fail");
    expect(invalid.fix).toMatch(/GITHUB_TOKEN/);
  });

  it("warns when no runner is available, but stays ok when at least one is", () => {
    const none = find(runDoctorChecks(baseEnv({ runners: [{ name: "node", available: false }, { name: "go", available: false }] })), "Test runners");
    expect(none.status).toBe("warn");
    const some = find(runDoctorChecks(baseEnv({ runners: [{ name: "node", available: true }, { name: "go", available: false }] })), "Test runners");
    expect(some.status).toBe("ok");
    expect(some.fix).toMatch(/optional/i);
  });

  it("warns when the MCP server or hook is not registered", () => {
    expect(find(runDoctorChecks(baseEnv({ mcpRegistered: false })), ".mcp.json").status).toBe("warn");
    expect(find(runDoctorChecks(baseEnv({ hookInstalled: false })), "Prompt hook").status).toBe("warn");
  });
});

describe("doctorExitCode + render", () => {
  it("exits 1 only when something is red", () => {
    expect(doctorExitCode(runDoctorChecks(baseEnv({ mcpRegistered: false, hookInstalled: false })))).toBe(0); // warns only
    expect(doctorExitCode(runDoctorChecks(baseEnv({ gitVersion: null })))).toBe(1); // a fail
  });

  it("renders a table with a fix line under each non-ok row and a summary", () => {
    const rs = runDoctorChecks(baseEnv({ gitVersion: null, mcpRegistered: false }));
    const table = renderDoctorTable("/repo", rs, false);
    expect(table).toContain("keel doctor — /repo");
    expect(table).toContain("↳ fix:");
    expect(table).toMatch(/1 failed, \d+ warnings?, \d+ ok/);
  });
});

describe("gatherDoctorEnv — real probes, hermetic", () => {
  let dir: string;
  const saved = { token: process.env["GITHUB_TOKEN"], ollama: process.env["KEEL_OLLAMA_URL"] };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-doctor-"));
    delete process.env["GITHUB_TOKEN"]; // no real GitHub call
    process.env["KEEL_OLLAMA_URL"] = "http://127.0.0.1:1"; // a dead port — probe fails fast, never hangs
  });
  afterEach(() => {
    rmDir(dir);
    if (saved.token === undefined) delete process.env["GITHUB_TOKEN"]; else process.env["GITHUB_TOKEN"] = saved.token;
    if (saved.ollama === undefined) delete process.env["KEEL_OLLAMA_URL"]; else process.env["KEEL_OLLAMA_URL"] = saved.ollama;
  });

  it("returns a well-formed env for a fresh git repo without throwing", async () => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const env = await gatherDoctorEnv(dir);
    expect(env.isRepo).toBe(true);
    expect(env.nodeVersion).toBe(process.version);
    expect(env.gitVersion).toMatch(/git version/);
    expect(env.db).toEqual({ state: "absent" }); // no events.db yet
    expect(env.ollama.reachable).toBe(false); // dead port
    expect(env.github).toEqual({ state: "absent" }); // no token
    expect(env.runners).toHaveLength(5);
    expect(env.runners.find((r) => r.name === "node")!.available).toBe(true); // node is obviously present
    expect(env.mcpRegistered).toBe(false);
    // The graph build is measured for real (an empty repo: 0 files, so no per-file division by zero).
    expect(env.graphBuild).toEqual({ state: "measured", files: 0, edges: 0, ms: expect.any(Number) });
    expect(find(runDoctorChecks(env), "Graph build").status).toBe("ok");
  }, 30_000);
});
