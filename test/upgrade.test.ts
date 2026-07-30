/**
 * `keel upgrade` Phase 0 — scope, break discovery, report. REPORT-ONLY.
 *
 * The fixture is a real npm install, offline. `test/fixtures/upgrade` vendors three versions of a
 * tiny package and wires them with `file:` specifiers, so `npm install` runs for real — the whole
 * point of the phase is that the bump is *installed and executed*, not modelled — while needing no
 * network and finishing in milliseconds. The versions are shaped to produce one of each break:
 *
 *   greeter@1.0.0  `greet(name)`                            — the baseline the fixture is written against
 *   greeter@2.0.0  `greet({ name })`, throws on a string    — a BREAKING call-site change
 *   greeter@3.0.0  same, plus a peer on sidecar@^2 while the repo has 1.0.0 — an install-time break
 *   greeter@4.0.0  v1's API, but an impossible `engines.node` — installs FINE, tests pass, still broken
 *
 * The repo has two import sites — one covered by a test, one covered by nothing — so the surface,
 * the blast radius, and the uncovered-surface warning are all observable, and a file that touches
 * greeter not at all proves the scope doesn't over-report.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resetGraphCache } from "../src/graph/cache.js";
import { initGraphScanners } from "../src/graph/scanners.js";
import { renderUpgradeReport } from "../src/upgrade/report.js";
import { readInstallSignals } from "../src/upgrade/install.js";
import { parseTarget, runUpgradeAnalysis, REPORT_ONLY_NOTICE } from "../src/upgrade/upgrade.js";
import { IS_WINDOWS, rmDir } from "./helpers/platform.js";
import { resolveOnPath } from "../src/util/platform.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "upgrade");
const NPM_ON_PATH = resolveOnPath("npm") !== null;

function git(dir: string, args: string[]): void {
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

/** Copy the fixture into a fresh git repo — the upgrade sandbox works from HEAD, so it must commit. */
function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-upgrade-"));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n.keel/\n");
  git(dir, ["init", "-b", "main"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "fixture"]);
  return dir;
}

let dir: string;
beforeAll(async () => {
  await initGraphScanners();
});
beforeEach(() => {
  resetGraphCache();
  dir = makeRepo();
});
afterEach(() => rmDir(dir));

// npm install runs for real; keep it off the network so the run is hermetic and fast. This is
// ambient npm config, not a keel knob — the product must never force offline.
function offline<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env["npm_config_offline"];
  process.env["npm_config_offline"] = "true";
  return run().finally(() => {
    if (previous === undefined) delete process.env["npm_config_offline"];
    else process.env["npm_config_offline"] = previous;
  });
}

describe("upgrade target parsing", () => {
  it("splits package from version, defaulting to latest", () => {
    expect(parseTarget("greeter@2.0.0")).toEqual({ package: "greeter", spec: "2.0.0" });
    expect(parseTarget("greeter")).toEqual({ package: "greeter", spec: "latest" });
    expect(parseTarget("greeter@latest")).toEqual({ package: "greeter", spec: "latest" });
  });

  it("keeps a scope attached to the package name", () => {
    expect(parseTarget("@scope/pkg@1.2.3")).toEqual({ package: "@scope/pkg", spec: "1.2.3" });
    expect(parseTarget("@scope/pkg")).toEqual({ package: "@scope/pkg", spec: "latest" });
  });

  it("accepts any npm specifier, including a file: path", () => {
    expect(parseTarget("greeter@file:vendor/greeter-2.0.0")).toEqual({ package: "greeter", spec: "file:vendor/greeter-2.0.0" });
  });

  it("reports an empty target as an error rather than guessing", () => {
    expect(parseTarget("  ")).toEqual({ error: expect.stringContaining("no package given") });
  });
});

describe("upgrade scope (graph only, no install)", () => {
  it("finds the import sites, the blast radius, and what no test covers", async () => {
    const report = await runUpgradeAnalysis(dir, "greeter@2.0.0", { scopeOnly: true });
    if ("error" in report) throw new Error(report.error);
    const { scope } = report;

    // Both files that require("greeter") — and only those.
    expect(scope.importSites).toEqual(["src/audit.js", "src/welcome.js"]);
    expect(scope.specifiers).toEqual(["greeter"]);

    // The surface adds the transitive dependents (banner imports welcome; its test imports banner).
    expect(scope.surface).toContain("src/banner.js");
    expect(scope.surface).toContain("src/banner.test.js");
    // A file with no path to greeter must NOT be in the surface — the scope has to be honest both ways.
    expect(scope.surface).not.toContain("src/unrelated.js");
    expect(scope.surface).not.toContain("src/unrelated.test.js");

    expect(scope.shareOfRepo).toBeGreaterThan(0);
    expect(scope.shareOfRepo).toBeLessThan(1);

    // Only banner.test.js reaches greeter; audit.js is reached by nothing.
    expect(scope.testsSelected).toEqual(["src/banner.test.js"]);
    expect(scope.uncoveredSurface).toContain("src/audit.js");
    expect(scope.uncoveredSurface).not.toContain("src/welcome.js"); // covered via banner
  });

  it("says plainly that a scope-only run proved nothing by executing", async () => {
    const report = await runUpgradeAnalysis(dir, "greeter@2.0.0", { scopeOnly: true });
    if ("error" in report) throw new Error(report.error);
    expect(report.scopeOnly).toBe(true);
    expect(report.nextSteps.join("\n")).toContain("no install and no tests were run");
    expect(report.reportOnly).toBe(REPORT_ONLY_NOTICE);

    // The rendered form must not show a green install section for an install that never ran —
    // that would read exactly like a clean bump.
    const text = renderUpgradeReport(report);
    expect(text).toContain("NOT RUN");
    expect(text).toContain("NOTHING below has been proven");
    expect(text).toContain("Verdict: withheld (scope-only)");
    expect(text).not.toContain("no peer-dependency or engine problems reported");
  });

  it("still reports what package.json declares today, rather than claiming it is undeclared", async () => {
    const report = await runUpgradeAnalysis(dir, "greeter@2.0.0", { scopeOnly: true });
    if ("error" in report) throw new Error(report.error);
    expect(report.from).toBe("file:vendor/greeter-1.0.0");
    expect(report.section).toBe("dependencies");
    expect(renderUpgradeReport(report)).not.toContain("not declared in package.json");
  });

  it("returns an empty surface for a package nothing imports", async () => {
    const report = await runUpgradeAnalysis(dir, "not-imported-anywhere@1.0.0", { scopeOnly: true });
    if ("error" in report) throw new Error(report.error);
    expect(report.scope.importSites).toEqual([]);
    expect(report.scope.surface).toEqual([]);
    expect(report.scope.testsSelected).toEqual([]);
  });
});

describe.skipIf(!NPM_ON_PATH || IS_WINDOWS)("upgrade break discovery (real install + executed tests)", () => {
  // Windows: the fixture's file: specifiers are posix-relative and npm rewrites them per-platform,
  // which makes the install path (not keel) the thing under test. The engines are identical, so the
  // POSIX legs carry this coverage.

  it("executes the bump and reports the failure with a graph path to the import site", async () => {
    const report = await offline(() => runUpgradeAnalysis(dir, "greeter@file:vendor/greeter-2.0.0", { maxSeconds: 120 }));
    if ("error" in report) throw new Error(report.error);

    // The install itself is clean — v2 declares no peers and no engine range.
    expect(report.install.ok).toBe(true);
    expect(report.install.signals).toEqual([]);
    expect(report.installedVersion).toBe("2.0.0");
    expect(report.from).toBe("file:vendor/greeter-1.0.0");
    expect(report.section).toBe("dependencies");

    // The break is EXECUTED, not predicted.
    expect(report.executed.status).toBe("failed");
    expect(report.executed.runner).toBe("node");
    const failure = report.executed.failures.find((f) => f.test.includes("banner"));
    expect(failure, `expected a banner failure, got ${JSON.stringify(report.executed.failures)}`).toBeDefined();
    expect(failure!.file).toBe("src/banner.test.js");
    expect(`${failure!.message}\n${failure!.trace ?? ""}`).toContain("greeter@2");

    // …and it maps back through the graph to the call site that has to change.
    expect(failure!.graphPath).toEqual(["src/banner.test.js", "src/banner.js", "src/welcome.js"]);
    expect(failure!.importSite).toBe("src/welcome.js");

    // The verdict for the bare bump is not a pass, and the report says no repair was attempted.
    expect(report.verdict.verdict).not.toBe("pass");
    expect(report.reportOnly).toContain("REPORT ONLY");
    expect(report.reportOnly).toContain("attempted no repairs");
  }, 180_000);

  it("passes a bump that changes nothing the call sites depend on", async () => {
    // greeter@1.0.0 -> the same version by path: installed, executed, and green.
    const report = await offline(() => runUpgradeAnalysis(dir, "greeter@file:vendor/greeter-1.0.0", { maxSeconds: 120 }));
    if ("error" in report) throw new Error(report.error);
    expect(report.install.ok).toBe(true);
    expect(report.executed.status).toBe("passed");
    expect(report.executed.failures).toEqual([]);
    // Still not silently "safe": the uncovered import site is called out as a work item.
    expect(report.nextSteps.join("\n")).toContain("reached by no test");
  }, 180_000);

  it("surfaces a peer-dependency conflict as a break in its own right", async () => {
    const report = await offline(() => runUpgradeAnalysis(dir, "greeter@file:vendor/greeter-3.0.0", { maxSeconds: 120 }));
    if ("error" in report) throw new Error(report.error);

    const kinds = report.install.signals.map((s) => s.kind);
    expect(kinds, `signals: ${JSON.stringify(report.install.signals)}`).toContain("peer-conflict");
    const peer = report.install.signals.find((s) => s.kind === "peer-conflict")!;
    expect(peer.message).toMatch(/peer dependency conflict/);
    expect(peer.evidence.length).toBeGreaterThan(0); // the receipt: npm's own lines

    // An install-time break is a work item like any other, and it is listed FIRST — it happens
    // before a test could run, and it can invalidate the test run entirely.
    expect(report.nextSteps[0]).toMatch(/^\[install\//);
    // And it must not be judged a pass just because no test failed.
    expect(report.verdict.verdict).not.toBe("pass");
  }, 180_000);

  it("surfaces an engine mismatch even when the install succeeds and every test passes", async () => {
    // The case a test run alone can never catch: npm exits 0, the suite is green, and the package
    // still declares a runtime this machine doesn't have. npm says so only in a warning.
    const report = await offline(() => runUpgradeAnalysis(dir, "greeter@file:vendor/greeter-4.0.0", { maxSeconds: 120 }));
    if ("error" in report) throw new Error(report.error);

    expect(report.install.ok).toBe(true);
    expect(report.executed.status).toBe("passed");
    expect(report.executed.failures).toEqual([]);

    const engine = report.install.signals.find((s) => s.kind === "engine-mismatch");
    expect(engine, `signals: ${JSON.stringify(report.install.signals)}`).toBeDefined();
    expect(engine!.evidence.join(" ")).toContain("EBADENGINE");
    expect(report.nextSteps[0]).toContain("[install/engine-mismatch]");
    // Green tests must not launder an install-time break into a pass.
    expect(report.verdict.verdict).not.toBe("pass");
  }, 180_000);

  it("honors and reports the test budget", async () => {
    const report = await offline(() =>
      runUpgradeAnalysis(dir, "greeter@file:vendor/greeter-1.0.0", { maxTests: 0, maxSeconds: 120 }),
    );
    if ("error" in report) throw new Error(report.error);
    expect(report.budget.maxTests).toBe(0);
    expect(report.budget.truncated).toBe(true);
    expect(report.budget.testsSkipped).toEqual(["src/banner.test.js"]);
    expect(report.nextSteps.join("\n")).toContain("covering test(s) were not run");
  }, 180_000);
});

describe("install signal detection", () => {
  it("reads a peer conflict out of npm's ERESOLVE block", () => {
    const output = [
      "npm warn ERESOLVE overriding peer dependency",
      "npm warn While resolving: greeter@3.0.0",
      "npm warn Could not resolve dependency:",
      'npm warn peer sidecar@"^2.0.0" from greeter@3.0.0',
    ].join("\n");
    const [signal] = readInstallSignals(output, 0);
    expect(signal!.kind).toBe("peer-conflict");
    expect(signal!.message).toContain("sidecar");
    expect(signal!.evidence).toContain("npm warn ERESOLVE overriding peer dependency");
  });

  it("reads an engine mismatch, which npm reports on a SUCCESSFUL install", () => {
    const output = [
      "npm warn EBADENGINE Unsupported engine {",
      "npm warn EBADENGINE   package: 'greeter@3.0.0',",
      "npm warn EBADENGINE   required: { node: '>=99.0.0' },",
      "npm warn EBADENGINE }",
    ].join("\n");
    const signals = readInstallSignals(output, 0); // exit 0 — scanning is the only way to catch it
    expect(signals.map((s) => s.kind)).toEqual(["engine-mismatch"]);
    expect(signals[0]!.message).toContain("does not support this runtime");
  });

  it("reports a non-zero install as its own break, carrying npm's error lines", () => {
    const output = "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/nope";
    const signals = readInstallSignals(output, 1);
    const failed = signals.find((s) => s.kind === "install-failed")!;
    expect(failed.message).toContain("exit 1");
    expect(failed.evidence[0]).toContain("E404");
  });

  it("finds nothing in a clean install log", () => {
    expect(readInstallSignals("added 2 packages in 91ms", 0)).toEqual([]);
  });
});

describe("upgrade report rendering", () => {
  it("states report-only twice, labels each discounted flaky, and lists work items", async () => {
    const base = await runUpgradeAnalysis(dir, "greeter@2.0.0", { scopeOnly: true });
    if ("error" in base) throw new Error(base.error);

    // Inject one real and one flaky failure so both halves of the discounting contract are visible.
    // scopeOnly is cleared: this exercises the FULL render, which a scope-only report short-circuits.
    const report = {
      ...base,
      scopeOnly: false,
      executed: {
        ...base.executed,
        status: "failed" as const,
        failures: [{ test: "banner greets", file: "src/banner.test.js", message: "boom", importSite: "src/welcome.js" }],
        discountedFlaky: [{ test: "sometimes", file: "src/banner.test.js", message: "timeout", flaky: true }],
      },
    };
    const text = renderUpgradeReport(report);

    // The honesty line appears at the top AND next to the work items, where it would otherwise read
    // like a plan keel was about to execute.
    expect(text.split("REPORT ONLY").length - 1).toBeGreaterThanOrEqual(1);
    expect(text).toContain("keel fixed nothing");

    // A discounted failure is shown, labelled, and reasoned — never silently dropped.
    expect(text).toContain("discounted: flaky per CI history");
    expect(text).toContain("so you can disagree");
    expect(text).toContain("sometimes");

    // Surface, import site and verdict all make it into the table.
    expect(text).toContain("Upgrade surface");
    expect(text).toContain("import site: src/welcome.js");
    expect(text).toContain("Verdict for the bare bump:");
    expect(text).toContain("a green run does NOT clear these");
  });
});
