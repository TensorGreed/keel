/**
 * `keel upgrade --repair` — Phase 1, the agent-driven repair loop.
 *
 * The loop is inverted: keel never writes a fix, so what these tests drive is the *other half* —
 * the agent. Each test plays that role, taking the task keel hands back, writing the patch a real
 * agent would write, and sending it in to be proven. The end-to-end case runs the whole cycle:
 * break → task → patch → GREEN, with a real (offline) npm install on every turn.
 *
 * The fixture repo keeps its vendored versions OUTSIDE the git repo (see helpers/upgrade-fixture),
 * so `greeter` behaves like a published dependency rather than in-repo source.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { resetGraphCache } from "../src/graph/cache.js";
import { initGraphScanners } from "../src/graph/scanners.js";
import { buildPackageEvidence, sliceChangelog, symbolsInPlay } from "../src/upgrade/evidence.js";
import { renderRepairStep } from "../src/upgrade/report.js";
import { runRepairStep, AGENT_WRITES_THE_FIX } from "../src/upgrade/repair.js";
import { IS_WINDOWS, rmDir } from "./helpers/platform.js";
import { makeUpgradeRepo, offline, type UpgradeFixture } from "./helpers/upgrade-fixture.js";
import { resolveOnPath } from "../src/util/platform.js";

const NPM_ON_PATH = resolveOnPath("npm") !== null;

/** The patch a competent agent would write for the v2 break: `greet(name)` → `greet({ name })`. */
const CORRECT_FIX = `diff --git a/src/welcome.js b/src/welcome.js
--- a/src/welcome.js
+++ b/src/welcome.js
@@ -1,4 +1,4 @@
 // Import site #1 — calls greet() the v1 way (a bare name). The v2 bump breaks exactly here.
 const { greet } = require("greeter");

-exports.welcome = (name) => greet(name).toUpperCase();
+exports.welcome = (name) => greet({ name }).toUpperCase();
`;

/** A patch that applies cleanly but doesn't fix anything — a plausible wrong guess. */
const WRONG_FIX = `diff --git a/src/welcome.js b/src/welcome.js
--- a/src/welcome.js
+++ b/src/welcome.js
@@ -1,4 +1,4 @@
 // Import site #1 — calls greet() the v1 way (a bare name). The v2 bump breaks exactly here.
 const { greet } = require("greeter");

-exports.welcome = (name) => greet(name).toUpperCase();
+exports.welcome = (name) => greet(String(name)).toUpperCase();
`;

let fixture: UpgradeFixture;
let dir: string;

beforeAll(async () => {
  await initGraphScanners();
});
afterEach(() => rmDir(fixture.root));

describe.skipIf(!NPM_ON_PATH || IS_WINDOWS)("the repair loop, driven as an agent would", () => {
  // Windows: npm rewrites file: specifiers per-platform, which would make npm's path handling — not
  // keel — the thing under test. The engines are identical, so the POSIX legs carry this coverage.
  beforeEach(() => {
    resetGraphCache();
    fixture = makeUpgradeRepo({ install: true }); // the CURRENT version on disk = a before/after diff
    dir = fixture.dir;
  });

  it("hands back ONE task with everything needed to write the fix", async () => {
    const step = await offline(() => runRepairStep(dir, fixture.target("2.0.0"), { maxSeconds: 120 }));
    if ("error" in step) throw new Error(step.error);

    expect(step.status).toBe("work");
    expect(step.attempt).toBe(1);
    expect(step.contract).toBe(AGENT_WRITES_THE_FIX);

    const task = step.task!;
    expect(task).toBeDefined();
    expect(task.kind).toBe("source");
    expect(task.remaining).toBe(0); // exactly one break in this fixture
    expect(step.outstanding).toHaveLength(1);

    // The failure, and the call site it points at.
    expect(task.failure!.test).toContain("banner");
    expect(task.failure!.graphPath).toEqual(["src/banner.test.js", "src/banner.js", "src/welcome.js"]);
    expect(task.targetFile).toBe("src/welcome.js");
    expect(task.source!.file).toBe("src/welcome.js");
    expect(task.source!.text).toContain('require("greeter")'); // the agent can see the call
    expect(task.failure!.trace).toContain("greeter@2");

    // The package's own account of the change.
    const evidence = task.evidence!;
    expect(evidence.fromVersion).toBe("1.0.0");
    expect(evidence.toVersion).toBe("2.0.0");
    expect(evidence.changelog!.spanned).toBe(true); // both version headings found
    expect(evidence.changelog!.excerpt).toContain("greet({ name })");
    expect(evidence.changelog!.excerpt).not.toContain("Initial release"); // 1.0.0's section is excluded
    expect(evidence.diff!.patch).toContain("greeter@2: greet() takes { name }"); // its real source diff
    expect(evidence.diff!.files).toContain("package.json");
  }, 180_000);

  it("runs the whole loop: break → task → patch → GREEN", async () => {
    const first = await offline(() => runRepairStep(dir, fixture.target("2.0.0"), { maxSeconds: 120 }));
    if ("error" in first) throw new Error(first.error);
    expect(first.status).toBe("work");

    // Play the agent: write the fix the task describes, send it back.
    const second = await offline(() =>
      runRepairStep(dir, fixture.target("2.0.0"), { patch: CORRECT_FIX, attempt: 2, maxSeconds: 120 }),
    );
    if ("error" in second) throw new Error(second.error);

    expect(second.status).toBe("green");
    expect(second.task).toBeUndefined();
    expect(second.outstanding).toEqual([]);
    expect(second.executed.failures).toEqual([]);
    expect(second.installedVersion).toBe("2.0.0");
    // Green is proven, not assumed: the tests really ran against the bumped tree.
    expect(second.executed.passed).toBeGreaterThan(0);
  }, 300_000);

  it("keeps issuing the task when the patch applies but doesn't work", async () => {
    const step = await offline(() =>
      runRepairStep(dir, fixture.target("2.0.0"), { patch: WRONG_FIX, attempt: 2, maxSeconds: 120 }),
    );
    if ("error" in step) throw new Error(step.error);
    expect(step.status).toBe("work");
    expect(step.task!.failure!.message).toContain("greeter@2");
  }, 180_000);

  it("blocks — rather than inventing a task — when the patch doesn't apply", async () => {
    const step = await offline(() =>
      runRepairStep(dir, fixture.target("2.0.0"), { patch: "diff --git a/nope.js b/nope.js\n--- a/nope.js\n+++ b/nope.js\n@@ -1 +1 @@\n-x\n+y\n", attempt: 2, maxSeconds: 120 }),
    );
    if ("error" in step) throw new Error(step.error);
    expect(step.status).toBe("blocked");
    expect(step.task).toBeUndefined();
    expect(step.blocked).toMatch(/does not apply/);
  }, 180_000);

  it("stops issuing tasks once the attempts are spent", async () => {
    const step = await offline(() =>
      runRepairStep(dir, fixture.target("2.0.0"), { attempt: 3, maxAttempts: 3, maxSeconds: 120 }),
    );
    if ("error" in step) throw new Error(step.error);
    expect(step.status).toBe("exhausted");
    expect(step.task).toBeUndefined();
    expect(step.outstanding.length).toBeGreaterThan(0); // what's left is still reported
  }, 180_000);

  it("runs the tests covering what the PATCH touched, not just the upgrade surface", async () => {
    // The fix is applied to an unrelated file, so its covering test is outside the upgrade surface.
    // Green must mean "green for everything this change touches", or it means very little.
    const unrelatedPatch = `diff --git a/src/unrelated.js b/src/unrelated.js
--- a/src/unrelated.js
+++ b/src/unrelated.js
@@ -1,2 +1,2 @@
 // Touches nothing from greeter: must stay OUT of the upgrade surface.
-exports.add = (a, b) => a + b;
+exports.add = (a, b) => a - b;
`;
    const step = await offline(() =>
      runRepairStep(dir, fixture.target("1.0.0"), { patch: unrelatedPatch, attempt: 2, maxSeconds: 120 }),
    );
    if ("error" in step) throw new Error(step.error);

    expect(step.testsRun).toContain("src/unrelated.test.js"); // pulled in by the patch
    expect(step.status).toBe("work");
    expect(step.outstanding.join("\n")).toContain("add adds"); // and it caught the regression
  }, 180_000);
});

describe("evidence gathering", () => {
  beforeEach(() => {
    resetGraphCache();
    fixture = makeUpgradeRepo();
    dir = fixture.dir;
  });

  it("reads which of the package's exports a file actually uses", () => {
    // `const { greet } = require("greeter")` — the TS scanner can't attribute a require's
    // destructuring to names, so it honestly over-approximates to the whole module.
    expect(symbolsInPlay(dir, "src/welcome.js", "greeter")).toEqual(["*"]);
    // A file that doesn't touch the package has nothing in play.
    expect(symbolsInPlay(dir, "src/unrelated.js", "greeter")).toEqual([]);
  });

  it("says what it could NOT establish, instead of returning quietly empty", async () => {
    const evidence = await buildPackageEvidence(null, null, [], 5_000);
    expect(evidence.changelog).toBeNull();
    expect(evidence.diff).toBeNull();
    expect(evidence.notes.join(" ")).toContain("no package evidence could be gathered");
  });
});

describe("changelog slicing", () => {
  const CHANGELOG = [
    "# Changelog",
    "",
    "## 3.0.0",
    "- future stuff nobody asked about",
    "",
    "## 2.0.0",
    "- BREAKING: greet takes an object",
    "",
    "## 1.0.0",
    "- initial release",
  ].join("\n");

  it("takes exactly the span between the installed version and the target", () => {
    const { excerpt, spanned } = sliceChangelog(CHANGELOG, "1.0.0", "2.0.0");
    expect(spanned).toBe(true);
    expect(excerpt).toContain("greet takes an object");
    expect(excerpt).not.toContain("initial release"); // the version you already have
    expect(excerpt).not.toContain("future stuff"); // a version you aren't going to
  });

  it("falls back to the top of the file and SAYS it isn't a span", () => {
    const { excerpt, spanned } = sliceChangelog(CHANGELOG, "0.9.0", "9.9.9");
    expect(spanned).toBe(false);
    expect(excerpt).toContain("# Changelog");
  });

  it("does not mistake 1.0.0 for 11.0.0", () => {
    const versioned = ["## 11.0.0", "- eleven", "", "## 1.0.0", "- one"].join("\n");
    const { excerpt, spanned } = sliceChangelog(versioned, "1.0.0", "11.0.0");
    expect(spanned).toBe(true);
    expect(excerpt).toContain("eleven");
    expect(excerpt).not.toContain("- one");
  });
});

describe("repair step rendering", () => {
  beforeEach(() => {
    resetGraphCache();
    fixture = makeUpgradeRepo();
    dir = fixture.dir;
  });

  it("leads with the contract, the task, and how to send the patch back", async () => {
    const step = await runRepairStep(dir, fixture.target("2.0.0"), { maxTests: 0, maxSeconds: 120 });
    if ("error" in step) throw new Error(step.error);
    const text = renderRepairStep(step);
    expect(text).toContain("Keel does not write fixes");
    expect(text).toContain(`attempt ${step.attempt}/${step.maxAttempts}`);
  }, 180_000);

  it("explains what a `*` symbol set means rather than printing a bare asterisk", () => {
    const text = renderRepairStep({
      status: "work",
      package: "greeter",
      requested: "2.0.0",
      installedVersion: "2.0.0",
      attempt: 1,
      maxAttempts: 10,
      scope: { package: "greeter", importSites: [], specifiers: [], surface: [], shareOfRepo: 0, testsSelected: [], uncoveredSurface: [], paths: {}, notes: [] },
      testsRun: ["a.test.js"],
      install: { ok: true, signals: [] },
      executed: { status: "failed", failures: [], discountedFlaky: [], durationMs: 10 },
      task: { kind: "source", title: "boom", targetFile: "src/welcome.js", symbolsInPlay: ["*"], remaining: 0 },
      outstanding: ["[source] boom"],
      memory: { pins: [], pastRepairs: [], notes: [] },
      contract: AGENT_WRITES_THE_FIX,
    });
    expect(text).toContain("the whole module");
    expect(text).toContain("treat every export as in play");
    expect(text).toMatch(/re-run with --patch .* --attempt 2/);
  });
});
