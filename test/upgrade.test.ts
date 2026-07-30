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
 *   greeter@4.0.0  v1's API, but an impossible `engines.node` — installs FINE, tests pass, still broken
 *
 * Peer-dependency conflicts are covered at unit level rather than end to end, deliberately: npm does
 * not enforce peer ranges for `file:` dependencies, so no offline fixture can provoke a real
 * ERESOLVE. The parser is pinned against npm's actual recorded output instead.
 *
 * The repo has two import sites — one covered by a test, one covered by nothing — so the surface,
 * the blast radius, and the uncovered-surface warning are all observable, and a file that touches
 * greeter not at all proves the scope doesn't over-report.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { resetGraphCache } from "../src/graph/cache.js";
import { initGraphScanners } from "../src/graph/scanners.js";
import { renderUpgradeReport } from "../src/upgrade/report.js";
import { readInstallSignals } from "../src/upgrade/install.js";
import { parseTarget, runUpgradeAnalysis, REPORT_ONLY_NOTICE } from "../src/upgrade/upgrade.js";
import { IS_WINDOWS, rmDir } from "./helpers/platform.js";
import { makeUpgradeRepo, offline, type UpgradeFixture } from "./helpers/upgrade-fixture.js";
import { resolveOnPath } from "../src/util/platform.js";

const NPM_ON_PATH = resolveOnPath("npm") !== null;

let fixture: UpgradeFixture;
let dir: string;
beforeAll(async () => {
  await initGraphScanners();
});
beforeEach(() => {
  resetGraphCache();
  fixture = makeUpgradeRepo();
  dir = fixture.dir;
});
afterEach(() => rmDir(fixture.root));

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
    expect(report.from).toContain("greeter-1.0.0");
    expect(report.section).toBe("dependencies");
    expect(renderUpgradeReport(report)).not.toContain("not declared in package.json");
  });

  it("explains a zero rather than reporting a confident-looking empty surface", async () => {
    // A package linked to in-repo source (a workspace package, or a file: dep pointing inside the
    // repo) resolves to real files, so it has no EXTERNAL import sites at all. Reporting "0" without
    // saying why would read as "nothing imports this" — the opposite of the truth.
    const linked = path.join(dir, "node_modules", "greeter");
    fs.mkdirSync(path.dirname(linked), { recursive: true });
    fs.symlinkSync(path.join(dir, "src"), linked, "dir");

    const report = await runUpgradeAnalysis(dir, "greeter@2.0.0", { scopeOnly: true });
    if ("error" in report) throw new Error(report.error);
    expect(report.scope.notes.join(" ")).toContain("linked to in-repo source");
    expect(report.scope.notes.join(" ")).toContain("not a dependency upgrade");
  });

  it("returns an empty surface for a package nothing imports", async () => {
    const report = await runUpgradeAnalysis(dir, "not-imported-anywhere@1.0.0", { scopeOnly: true });
    if ("error" in report) throw new Error(report.error);
    expect(report.scope.importSites).toEqual([]);
    expect(report.scope.surface).toEqual([]);
    expect(report.scope.testsSelected).toEqual([]);
    expect(report.scope.notes.join(" ")).toContain("no file in the graph imports");
  });
});

describe.skipIf(!NPM_ON_PATH || IS_WINDOWS)("upgrade break discovery (real install + executed tests)", () => {
  // Windows: npm rewrites file: specifiers per-platform, which would make npm's path handling — not
  // keel — the thing under test. The engines are identical, so the POSIX legs carry this coverage.

  it("executes the bump and reports the failure with a graph path to the import site", async () => {
    const report = await offline(() => runUpgradeAnalysis(dir, fixture.target("2.0.0"), { maxSeconds: 120 }));
    if ("error" in report) throw new Error(report.error);

    // The install itself is clean — v2 declares no peers and no engine range.
    expect(report.install.ok).toBe(true);
    expect(report.install.signals).toEqual([]);
    expect(report.installedVersion).toBe("2.0.0");
    expect(report.from).toContain("greeter-1.0.0");
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
    const report = await offline(() => runUpgradeAnalysis(dir, fixture.target("1.0.0"), { maxSeconds: 120 }));
    if ("error" in report) throw new Error(report.error);
    expect(report.install.ok).toBe(true);
    expect(report.executed.status).toBe("passed");
    expect(report.executed.failures).toEqual([]);
    // Still not silently "safe": the uncovered import site is called out as a work item.
    expect(report.nextSteps.join("\n")).toContain("reached by no test");
  }, 180_000);

  it("reports a failed install as a break, and never as a pass", async () => {
    // An install that cannot complete. The tests never run, so there is nothing to be green about —
    // the failure has to surface as the install's, with npm's own error attached.
    // A registry specifier while npm is pinned offline: nothing to resolve it from, deterministically.
    const report = await offline(() => runUpgradeAnalysis(dir, "greeter@99.99.99", { maxSeconds: 120 }));
    if ("error" in report) throw new Error(report.error);

    expect(report.install.ok).toBe(false);
    const failed = report.install.signals.find((s) => s.kind === "install-failed");
    expect(failed, `signals: ${JSON.stringify(report.install.signals)}`).toBeDefined();
    expect(failed!.evidence.length).toBeGreaterThan(0); // npm's own error lines, as the receipt

    // An install-time break is a work item like any other, and it is listed FIRST — it happens
    // before a test could run, and it invalidates the test run entirely.
    expect(report.nextSteps[0]).toMatch(/^\[install\//);
    expect(report.verdict.verdict).not.toBe("pass");
  }, 180_000);

  it("surfaces an engine mismatch even when the install succeeds and every test passes", async () => {
    // The case a test run alone can never catch: npm exits 0, the suite is green, and the package
    // still declares a runtime this machine doesn't have. npm says so only in a warning.
    const report = await offline(() => runUpgradeAnalysis(dir, fixture.target("4.0.0"), { maxSeconds: 120 }));
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
      runUpgradeAnalysis(dir, fixture.target("1.0.0"), { maxTests: 0, maxSeconds: 120 }),
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
