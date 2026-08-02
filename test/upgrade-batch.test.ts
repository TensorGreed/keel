/**
 * `keel upgrade --batch` — Phase 3: many packages in one pass, classified by policy.
 *
 * Three things this has to get right, and each has a way of being quietly wrong:
 *
 *   - **Ranking.** The risk score decides the order the batch spends its budget in, so the score
 *     and its components are asserted directly rather than inferred from the ordering.
 *   - **Classification.** `auto-merge` is the one outcome that removes a human from the loop, so
 *     every gate on it is tested separately — a pin, a reserved package, a recorded decision, an
 *     uncovered surface, and (the subtle one) a bump that installed cleanly but that no test covers.
 *     "No test failed" and "no test ran" produce the same verdict and mean completely different
 *     things.
 *   - **Truncation.** A batch that runs out of budget must report the packages it never reached, in
 *     rank order, as `not-run`. Silently returning a clean-looking result for a batch that stopped
 *     early is the worst thing this command could do.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { SqliteEventStore } from "../src/events/sqlite-store.js";
import { resetGraphCache } from "../src/graph/cache.js";
import { initGraphScanners } from "../src/graph/scanners.js";
import { DEFAULT_POLICY, parsePolicy, type Policy } from "../src/trust/policy.js";
import { classify, packageMatches, pinFor, riskScore, runUpgradeBatch, versionJump } from "../src/upgrade/batch.js";
import { buildPrProposal, manifestPatch } from "../src/upgrade/pr.js";
import { renderBatchResult } from "../src/upgrade/report.js";
import type { UpgradeReport } from "../src/upgrade/upgrade.js";
import { IS_WINDOWS, rmDir } from "./helpers/platform.js";
import { makeUpgradeRepo, offline, type UpgradeFixture } from "./helpers/upgrade-fixture.js";
import { resolveOnPath } from "../src/util/platform.js";

const NPM_ON_PATH = resolveOnPath("npm") !== null;

let fixture: UpgradeFixture;
let dir: string;
let store: SqliteEventStore;

beforeAll(async () => {
  await initGraphScanners();
});
afterEach(() => {
  store?.close();
  if (fixture) rmDir(fixture.root); // the pure describes below never build one
});

function writePolicy(upgrades: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, "keel.policy.json"), JSON.stringify({ version: 1, upgrades }, null, 2));
}

/** A green report, shaped for classify() — the fields it actually reads. */
function greenReport(over: Partial<UpgradeReport> = {}): UpgradeReport {
  return {
    package: "greeter",
    requested: "2.0.0",
    from: "^1.0.0",
    section: "dependencies",
    installedVersion: "2.0.0",
    scope: { package: "greeter", importSites: ["src/welcome.js"], specifiers: ["greeter"], surface: ["src/welcome.js"], shareOfRepo: 0.2, testsSelected: ["src/banner.test.js"], uncoveredSurface: [], paths: {}, notes: [] },
    install: { ran: true, ok: true, exitCode: 0, signals: [] },
    executed: { status: "passed", runner: "node", passed: 1, failed: 0, failures: [], discountedFlaky: [], durationMs: 10 },
    nextSteps: [],
    memory: { pins: [], pastRepairs: [], notes: [] },
    reportOnly: "",
    scopeOnly: false,
    verdict: { verdict: "pass", reasons: [] },
    budget: { maxTests: 50, maxSeconds: 300, testsSkipped: [], truncated: false },
    ...over,
  } as UpgradeReport;
}

const AUTO_MERGE_POLICY: Policy = { ...DEFAULT_POLICY, upgrades: { autoMergeOnGreen: true, alwaysReview: [], pinned: [] } };

describe("upgrade policy parsing", () => {
  it("accepts an upgrades block and defaults it when absent", () => {
    const withBlock = parsePolicy({ version: 1, upgrades: { autoMergeOnGreen: true, alwaysReview: ["react"], pinned: [{ package: "lodash", reason: "held at 4.x" }] } });
    expect("error" in withBlock).toBe(false);
    expect((withBlock as Policy).upgrades).toEqual({ autoMergeOnGreen: true, alwaysReview: ["react"], pinned: [{ package: "lodash", reason: "held at 4.x" }] });

    const without = parsePolicy({ version: 1 });
    expect((without as Policy).upgrades).toEqual({ autoMergeOnGreen: false, alwaysReview: [], pinned: [] });
  });

  it("refuses a pin with no stated reason", () => {
    // The whole value of a pin is the reason. Six months on, an unexplained one is just noise
    // somebody deletes — so the schema won't accept it.
    const result = parsePolicy({ version: 1, upgrades: { pinned: [{ package: "lodash", reason: "" }] } });
    expect(result).toEqual({ error: expect.stringContaining("a pin without a stated reason is unmaintainable") });
  });

  it("rejects a malformed upgrades block precisely, rather than ignoring it", () => {
    expect(parsePolicy({ version: 1, upgrades: { autoMergeOnGreen: "yes" } })).toEqual({ error: expect.stringContaining("autoMergeOnGreen") });
    expect(parsePolicy({ version: 1, upgrades: { alwaysReview: "react" } })).toEqual({ error: expect.stringContaining("alwaysReview") });
    expect(parsePolicy({ version: 1, upgrades: { pinned: [{ package: "x" }] } })).toEqual({ error: expect.stringContaining("pinned") });
  });
});

describe("risk ranking", () => {
  it("reads a version jump, and treats an unparseable one as nearly a major", () => {
    expect(versionJump("^1.2.3", "2.0.0")).toBe("major");
    expect(versionJump("^1.2.3", "1.3.0")).toBe("minor");
    expect(versionJump("^1.2.3", "1.2.4")).toBe("patch");
    // A file: path or a dist-tag tells us nothing; guessing "patch" would understate it.
    expect(versionJump("file:vendor/x", "file:vendor/y")).toBe("unknown");
    expect(versionJump(null, "latest")).toBe("unknown");
    expect(riskScore({ shareOfRepo: 0, uncoveredShare: 0, versionJump: "unknown", pinnedByDecision: false }))
      .toBeGreaterThan(riskScore({ shareOfRepo: 0, uncoveredShare: 0, versionJump: "minor", pinnedByDecision: false }));
  });

  it("scores reach and unproven reach above everything else", () => {
    const wide = riskScore({ shareOfRepo: 1, uncoveredShare: 1, versionJump: "patch", pinnedByDecision: false });
    const narrowMajor = riskScore({ shareOfRepo: 0.01, uncoveredShare: 0, versionJump: "major", pinnedByDecision: true });
    expect(wide).toBeGreaterThan(narrowMajor);
    expect(wide).toBeLessThanOrEqual(1);
  });

  it("lifts the score when a recorded decision mentions the package", () => {
    const base = { shareOfRepo: 0.2, uncoveredShare: 0.1, versionJump: "minor" as const };
    expect(riskScore({ ...base, pinnedByDecision: true })).toBeGreaterThan(riskScore({ ...base, pinnedByDecision: false }));
  });
});

describe("policy matching", () => {
  it("matches a package name, and a glob including scoped names", () => {
    expect(packageMatches("react", "react")).toBe(true);
    expect(packageMatches("react", "react-dom")).toBe(false);
    expect(packageMatches("@acme/*", "@acme/ui")).toBe(true);
    expect(packageMatches("@acme/*", "@other/ui")).toBe(false);
    expect(packageMatches("*", "anything")).toBe(true);
  });

  it("finds the pin covering a package", () => {
    const policy: Policy = { ...DEFAULT_POLICY, upgrades: { autoMergeOnGreen: false, alwaysReview: [], pinned: [{ package: "@acme/*", reason: "internal" }] } };
    expect(pinFor(policy, "@acme/ui")?.reason).toBe("internal");
    expect(pinFor(policy, "react")).toBeNull();
  });
});

describe("classification — every gate on auto-merge", () => {
  it("auto-merges only when the policy opted in, it's green, and it's fully covered", () => {
    expect(classify(greenReport(), AUTO_MERGE_POLICY).outcome).toBe("auto-merge");
    // The default policy has expressed no opinion, so it cannot mean "merge without a human".
    expect(classify(greenReport(), DEFAULT_POLICY).outcome).toBe("needs-review");
  });

  it("never auto-merges a package reserved for review", () => {
    const policy: Policy = { ...AUTO_MERGE_POLICY, upgrades: { ...AUTO_MERGE_POLICY.upgrades, alwaysReview: ["gree*"] } };
    const result = classify(greenReport(), policy);
    expect(result.outcome).toBe("needs-review");
    expect(result.reason).toContain("reserves");
  });

  it("never auto-merges when a recorded decision mentions the dependency", () => {
    const report = greenReport({ memory: { pins: [{ id: "d1", summary: "Hold greeter at 1.x", rationale: "", alternatives: [], confidence: "high", origin: "human", matchReason: "keyword", source: { pr: null, url: null, author: null, date: null }, files: [] }], pastRepairs: [], notes: [] } });
    const result = classify(report, AUTO_MERGE_POLICY);
    expect(result.outcome).toBe("needs-review");
    expect(result.reason).toContain("recorded decision");
  });

  it("never auto-merges when part of the surface is reached by no test", () => {
    const report = greenReport({ scope: { ...greenReport().scope, uncoveredSurface: ["src/audit.js"] } });
    const result = classify(report, AUTO_MERGE_POLICY);
    expect(result.outcome).toBe("needs-review");
    expect(result.reason).toContain("reached by no test");
  });

  it("never auto-merges a bump that installed cleanly but that NO test covers", () => {
    // The subtle one: "no test failed" and "no test ran" are the same verdict and completely
    // different facts. A clean install proves the tree resolves, and nothing about the code.
    const report = greenReport({ executed: { ...greenReport().executed, status: "no-tests", passed: 0 } });
    const result = classify(report, AUTO_MERGE_POLICY);
    expect(result.outcome).toBe("needs-review");
    expect(result.reason).toContain("NO test covers this dependency");
  });

  it("treats an install that never ran as unproven, and one that failed as blocked", () => {
    const notRun = classify(greenReport({ install: { ran: false, ok: false, exitCode: null, signals: [] } }), AUTO_MERGE_POLICY);
    expect(notRun.outcome).toBe("needs-review");
    expect(notRun.reason).toContain("nothing was installed or executed");

    const failed = classify(greenReport({ install: { ran: true, ok: false, exitCode: 1, signals: [] } }), AUTO_MERGE_POLICY);
    expect(failed.outcome).toBe("blocked");
  });

  it("blocks a failing bump and names what failed", () => {
    const report = greenReport({
      verdict: { verdict: "block", reasons: [{ rule: "requireSimPass", outcome: "block", detail: "1 test(s) failed" }] },
      executed: { ...greenReport().executed, status: "failed", failures: [{ test: "banner greets", message: "boom" }] },
    });
    const result = classify(report, AUTO_MERGE_POLICY);
    expect(result.outcome).toBe("blocked");
    expect(result.reason).toContain("1 test(s) fail");
  });
});

describe("PR proposals", () => {
  beforeEach(() => {
    resetGraphCache();
    fixture = makeUpgradeRepo();
    dir = fixture.dir;
    store = new SqliteEventStore(path.join(dir, ".keel", "events.db"));
  });

  /** The greeter spec the fixture's package.json actually declares — the "from" side of a patch. */
  function declaredGreeter(): string {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    return manifest.dependencies["greeter"]!;
  }

  it("emits a manifest patch that git apply actually accepts", () => {
    // The point of the whole thing: a decorative diff would look right in a report and fail the
    // moment anyone used it. So the patch is applied for real here.
    const report = greenReport({ package: "greeter", from: declaredGreeter(), installedVersion: "2.0.0" });

    const patch = manifestPatch(dir, report);
    expect(patch).toContain("diff --git a/package.json b/package.json");
    expect(patch).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/); // a REAL hunk header, with line numbers

    const patchFile = path.join(fixture.root, "bump.patch");
    fs.writeFileSync(patchFile, patch);
    expect(() => {
      execFileSync("git", ["apply", "--check", patchFile], { cwd: dir, stdio: "pipe" });
    }).not.toThrow();
  });

  it("finds a spec containing characters JSON escapes — a Windows path, on any platform", () => {
    // The failure this pins: `report.from` comes back from JSON.parse, so a Windows `file:` spec
    // reads as `file:C:\repo\dep` while package.json stores `file:C:\\repo\\dep`. Searching the raw
    // file text for the decoded value found nothing, and the upgrade silently offered no patch —
    // reproducible here on every platform, which is where it should have been caught.
    const windowsSpec = "file:C:\\Users\\RUNNER~1\\registry\\greeter-1.0.0";
    fs.writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "fixture", dependencies: { greeter: windowsSpec } }, null, 2)}\n`,
    );
    const report = greenReport({ package: "greeter", from: windowsSpec, installedVersion: "2.0.0" });

    const patch = manifestPatch(dir, report);
    expect(patch, "a JSON-escaped spec must still be located").toContain("diff --git a/package.json");
    expect(patch).toContain('-    "greeter": "file:C:\\\\Users');
    expect(patch).toContain('+    "greeter": "^2.0.0"');

    const patchFile = path.join(fixture.root, "win.patch");
    fs.writeFileSync(patchFile, patch);
    expect(() => {
      execFileSync("git", ["apply", "--check", patchFile], { cwd: dir, stdio: "pipe" });
    }).not.toThrow();
  });

  it("offers no patch — and says why — when the package isn't declared", () => {
    const report = greenReport({ package: "greeter", from: null });
    expect(manifestPatch(dir, report)).toBe("");
    const proposal = buildPrProposal(dir, report, "needs-review")!;
    expect(proposal.commands.join(" ")).toContain("not declared in package.json");
  });

  it("carries the executed proof in the body, and never claims keel will open it", () => {
    const report = greenReport({
      from: declaredGreeter(),
      executed: { ...greenReport().executed, status: "failed", failures: [{ test: "banner greets", file: "src/banner.test.js", message: "boom", importSite: "src/welcome.js" }] },
      scope: { ...greenReport().scope, uncoveredSurface: ["src/audit.js"] },
      verdict: { verdict: "block", reasons: [{ rule: "requireSimPass", outcome: "block", detail: "1 test(s) failed" }] },
    });
    const proposal = buildPrProposal(dir, report, "blocked")!;

    expect(proposal.branch).toBe("keel/upgrade/greeter-2.0.0");
    expect(proposal.title).toContain("upgrade greeter to 2.0.0");
    expect(proposal.body).toContain("### Failing tests");
    expect(proposal.body).toContain("import site: `src/welcome.js`");
    expect(proposal.body).toContain("### Not proven by this run");
    expect(proposal.body).toContain("executed** in an isolated worktree, not predicted");
    expect(proposal.autoMergeable).toBe(false);
    // Commands for a human to run — keel pushes nothing.
    expect(proposal.commands.some((c) => c.startsWith("git push"))).toBe(true);
  });

  it("proposes nothing for a package that was pinned or never reached", () => {
    expect(buildPrProposal(dir, greenReport(), "pinned")).toBeUndefined();
    expect(buildPrProposal(dir, greenReport(), "not-run")).toBeUndefined();
  });
});

describe.skipIf(!NPM_ON_PATH || IS_WINDOWS)("running a batch", () => {
  // Windows: npm rewrites file: specifiers per-platform — see upgrade.test.ts.
  beforeEach(() => {
    resetGraphCache();
    fixture = makeUpgradeRepo({ install: true });
    dir = fixture.dir;
    store = new SqliteEventStore(path.join(dir, ".keel", "events.db"));
  });

  it("runs safest first, and classifies each package against the policy", async () => {
    writePolicy({ autoMergeOnGreen: true, alwaysReview: ["sidecar"], pinned: [{ package: "left-pad", reason: "vendored in #401" }] });

    const result = await offline(() =>
      runUpgradeBatch(dir, [fixture.target("2.0.0"), fixture.target("1.0.0", "sidecar"), "left-pad@1.3.0"], { store, maxSecondsPerPackage: 120 }),
    );
    if ("error" in result) throw new Error(result.error);

    expect(result.entries).toHaveLength(3);
    expect(result.policySource).toBe("file");

    // Ascending risk: greeter reaches most of the repo, so it runs last.
    const risks = result.entries.map((e) => e.risk);
    expect([...risks].sort((a, b) => a - b)).toEqual(risks);
    expect(result.entries[result.entries.length - 1]!.package).toBe("greeter");

    const byPackage = Object.fromEntries(result.entries.map((e) => [e.package, e]));
    // Pinned: never executed, and the reason comes from the policy.
    expect(byPackage["left-pad"]!.outcome).toBe("pinned");
    expect(byPackage["left-pad"]!.reason).toContain("vendored in #401");
    expect(byPackage["left-pad"]!.report).toBeUndefined();
    expect(byPackage["left-pad"]!.pr).toBeUndefined();
    // Reserved for review even though the policy enables auto-merge.
    expect(byPackage["sidecar"]!.outcome).toBe("needs-review");
    // And the real break blocks, with a PR proposal carrying the proof.
    expect(byPackage["greeter"]!.outcome).toBe("blocked");
    expect(byPackage["greeter"]!.pr!.body).toContain("### Failing tests");

    expect(result.summary).toEqual({ pinned: 1, "auto-merge": 0, "needs-review": 1, blocked: 1, "not-run": 0 });
  }, 600_000);

  it("reports the packages it never reached instead of quietly finishing", async () => {
    // A budget already spent: every package should come back named, in rank order, as not-run.
    const result = await offline(() =>
      runUpgradeBatch(dir, [fixture.target("2.0.0"), fixture.target("1.0.0", "sidecar")], { store, maxSeconds: 0 }),
    );
    if ("error" in result) throw new Error(result.error);

    expect(result.entries.every((e) => e.outcome === "not-run")).toBe(true);
    expect(result.entries[0]!.reason).toContain("budget");
    expect(result.budget.exhausted).toBe(true);
    expect(result.notes.join(" ")).toContain("This is not a clean result");

    const text = renderBatchResult(result);
    expect(text).toContain("NOT RUN");
    expect(text).toContain("EXHAUSTED");
  }, 600_000);

  it("says nothing can auto-merge when there is no policy file", async () => {
    const result = await offline(() => runUpgradeBatch(dir, [fixture.target("1.0.0", "sidecar")], { store, maxSecondsPerPackage: 120 }));
    if ("error" in result) throw new Error(result.error);
    expect(result.policySource).toBe("default");
    expect(result.notes.join(" ")).toContain("nothing can auto-merge");
    expect(result.summary["auto-merge"]).toBe(0);
  }, 600_000);

  it("refuses to run at all on a malformed policy, rather than falling back to defaults", async () => {
    fs.writeFileSync(path.join(dir, "keel.policy.json"), JSON.stringify({ version: 1, upgrades: { pinned: [{ package: "x" }] } }));
    const result = await runUpgradeBatch(dir, [fixture.target("1.0.0", "sidecar")], { store });
    expect(result).toEqual({ error: expect.stringContaining("keel.policy.json is invalid") });
  }, 120_000);

  it("errors on an empty target list rather than reporting an empty success", async () => {
    expect(await runUpgradeBatch(dir, [], {})).toEqual({ error: expect.stringContaining("no packages given") });
  });
});
