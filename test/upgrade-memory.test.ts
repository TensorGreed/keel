/**
 * `keel upgrade` Phase 2 — memory-informed repair.
 *
 * The failure this guards against isn't a broken test; it's a *correct* repair of an upgrade the
 * team already rejected. Executing a bump proves which tests break. It can never surface that the
 * version was pinned on purpose, with a reason, in a PR nobody remembers. Only the decision index
 * can — so these tests check that a recorded pin reaches the agent BEFORE it writes anything, with
 * its receipt, and that keel still refuses to judge whether the pin actually forbids the upgrade.
 *
 * The second half is the flywheel: a repair that reaches green is written back to the event log, so
 * the next upgrade of that package starts from the migration the first one worked out.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { SqliteEventStore } from "../src/events/sqlite-store.js";
import { resetGraphCache } from "../src/graph/cache.js";
import { initGraphScanners } from "../src/graph/scanners.js";
import { recallPastRepairs, recallUpgradeMemory, recordRepair, PIN_FRAMING } from "../src/upgrade/memory.js";
import { renderUpgradeReport } from "../src/upgrade/report.js";
import { runRepairStep } from "../src/upgrade/repair.js";
import { runUpgradeAnalysis } from "../src/upgrade/upgrade.js";
import { IS_WINDOWS, rmDir } from "./helpers/platform.js";
import { makeUpgradeRepo, offline, type UpgradeFixture } from "./helpers/upgrade-fixture.js";
import { resolveOnPath } from "../src/util/platform.js";

const NPM_ON_PATH = resolveOnPath("npm") !== null;

const CORRECT_FIX = `diff --git a/src/welcome.js b/src/welcome.js
--- a/src/welcome.js
+++ b/src/welcome.js
@@ -1,4 +1,4 @@
 // Import site #1 — calls greet() the v1 way (a bare name). The v2 bump breaks exactly here.
 const { greet } = require("greeter");

-exports.welcome = (name) => greet(name).toUpperCase();
+exports.welcome = (name) => greet({ name }).toUpperCase();
`;

let fixture: UpgradeFixture;
let dir: string;
let store: SqliteEventStore;

beforeAll(async () => {
  await initGraphScanners();
});
beforeEach(() => {
  resetGraphCache();
  fixture = makeUpgradeRepo();
  dir = fixture.dir;
  store = new SqliteEventStore(path.join(dir, ".keel", "events.db"));
});
afterEach(() => {
  store.close();
  rmDir(fixture.root);
});

/** A human-recorded pin, the shape `keel decision add` writes. */
async function addPin(summary: string, rationale: string, files: string[] = []): Promise<void> {
  await store.append({
    kind: "decision",
    externalId: `human:${summary.slice(0, 20)}`,
    occurredAt: "2026-01-01T00:00:00Z",
    actor: "alice",
    title: summary,
    payload: { origin: "human", summary, rationale, alternatives: [], confidence: "high" },
    files,
  });
}

describe("recalling what the team already decided", () => {
  it("finds a pin that names the package, wherever it is attached", async () => {
    await addPin(
      "Hold greeter at 1.x",
      "The 2.x greet() signature breaks every call site we have; revisit after the upload rewrite. See #812.",
    );

    const memory = await recallUpgradeMemory(dir, store, "greeter", ["src/welcome.js"], null);
    expect(memory.pins).toHaveLength(1);
    expect(memory.pins[0]!.summary).toContain("Hold greeter at 1.x");
    expect(memory.pins[0]!.origin).toBe("human");
    // Framed, not asserted: keel surfaces the decision, it does not rule on it.
    expect(memory.notes[0]).toBe(PIN_FRAMING);
    expect(PIN_FRAMING).toContain("keel does not judge whether they");
  });

  it("ignores a decision that has nothing to do with the package", async () => {
    await addPin("Use Redis for sessions", "Postgres session storage was too slow under load.");
    const memory = await recallUpgradeMemory(dir, store, "greeter", ["src/welcome.js"], null);
    expect(memory.pins).toEqual([]);
  });

  it("returns empty memory rather than failing when nothing has been recorded", async () => {
    const memory = await recallUpgradeMemory(dir, store, "greeter", ["src/welcome.js"], null);
    expect(memory.pins).toEqual([]);
    expect(memory.pastRepairs).toEqual([]);
  });
});

describe("recording a repair as memory", () => {
  it("round-trips a repair and returns it for the next upgrade of that package", async () => {
    await recordRepair(store, {
      package: "greeter",
      from: "1.0.0",
      to: "2.0.0",
      patch: CORRECT_FIX,
      provenTests: ["src/banner.test.js"],
      importSites: ["src/welcome.js"],
      attempts: 2,
      now: "2026-02-01T00:00:00Z",
    });

    const [repair] = await recallPastRepairs(store, "greeter");
    expect(repair).toBeDefined();
    expect(repair!.from).toBe("1.0.0");
    expect(repair!.to).toBe("2.0.0");
    expect(repair!.attempts).toBe(2);
    expect(repair!.provenTests).toEqual(["src/banner.test.js"]);
    expect(repair!.patch).toContain("greet({ name })"); // the migration itself, ready to reuse
  });

  it("is idempotent for the same patch, but keeps a genuinely different one", async () => {
    const base = { package: "greeter", from: "1.0.0", to: "2.0.0", provenTests: [], importSites: [], attempts: 1, now: "2026-02-01T00:00:00Z" };
    const first = await recordRepair(store, { ...base, patch: CORRECT_FIX });
    const again = await recordRepair(store, { ...base, patch: CORRECT_FIX });
    expect(again).toBe(first); // re-proving the same green step records nothing new
    expect(await recallPastRepairs(store, "greeter")).toHaveLength(1);

    // A different patch for the same bump is real history, not a duplicate.
    await recordRepair(store, { ...base, patch: `${CORRECT_FIX}\n// another way\n` });
    expect(await recallPastRepairs(store, "greeter")).toHaveLength(2);
  });

  it("does not hand one package's repairs to another", async () => {
    await recordRepair(store, {
      package: "greeter", from: "1.0.0", to: "2.0.0", patch: CORRECT_FIX,
      provenTests: [], importSites: [], attempts: 1, now: "2026-02-01T00:00:00Z",
    });
    expect(await recallPastRepairs(store, "sidecar")).toEqual([]);
  });

  it("caps a runaway patch instead of writing it whole into the log", async () => {
    const huge = "x".repeat(30_000);
    await recordRepair(store, {
      package: "greeter", from: null, to: "2.0.0", patch: huge,
      provenTests: [], importSites: [], attempts: 1, now: "2026-02-01T00:00:00Z",
    });
    const [repair] = await recallPastRepairs(store, "greeter");
    expect(repair!.patch.length).toBeLessThan(huge.length);
    expect(repair!.patch).toContain("patch truncated by keel");
  });
});

describe("memory reaches the report before any proof does", () => {
  it("puts a pin at the TOP of next steps, whatever the policy says", async () => {
    // No keel.policy.json here, so requireDecisionReview is off by default. The REPORT must surface
    // the pin regardless: what the team recorded isn't a policy opinion, it's a fact about the repo.
    await addPin("Hold greeter at 1.x", "The 2.x greet() signature breaks our call sites. See #812.");

    const report = await runUpgradeAnalysis(dir, "greeter@2.0.0", { scopeOnly: true, store });
    if ("error" in report) throw new Error(report.error);

    expect(report.memory.pins).toHaveLength(1);
    // Ahead of every other work item: a pin questions whether to upgrade at all, which no test answers.
    expect(report.nextSteps[0]).toContain("[decision/human]");
    expect(report.nextSteps[0]).toContain("Hold greeter at 1.x");

    const text = renderUpgradeReport(report);
    expect(text).toContain("Team memory");
    expect(text).toContain("keel does not judge whether they forbid it");
    expect(text).toContain("receipt:");
  }, 180_000);

  it("lets the trust layer judge a pin by the SAME rule it uses for any other change", async () => {
    fs.writeFileSync(
      path.join(dir, "keel.policy.json"),
      JSON.stringify({ version: 1, requireDecisionReview: true }, null, 2),
    );
    await addPin("Hold greeter at 1.x", "The 2.x greet() signature breaks our call sites. See #812.");

    const report = await runUpgradeAnalysis(dir, "greeter@2.0.0", { scopeOnly: true, store });
    if ("error" in report) throw new Error(report.error);

    const reason = report.verdict.reasons.find((r) => r.rule === "requireDecisionReview");
    expect(reason, `reasons: ${JSON.stringify(report.verdict.reasons)}`).toBeDefined();
    expect(reason!.outcome).toBe("warn");
    expect(reason!.detail).toContain("human-recorded");
    expect(report.verdict.verdict).not.toBe("pass");
  }, 180_000);

  it("says there is no recorded decision, rather than staying silent", async () => {
    const report = await runUpgradeAnalysis(dir, "greeter@2.0.0", { scopeOnly: true, store });
    if ("error" in report) throw new Error(report.error);
    expect(renderUpgradeReport(report)).toContain("no recorded decision mentions this dependency");
  }, 180_000);
});

describe.skipIf(!NPM_ON_PATH || IS_WINDOWS)("the flywheel: a green repair becomes the next one's context", () => {
  // Windows: npm rewrites file: specifiers per-platform — see upgrade.test.ts.
  beforeEach(() => {
    resetGraphCache();
    fixture = makeUpgradeRepo({ install: true });
    dir = fixture.dir;
    store = new SqliteEventStore(path.join(dir, ".keel", "events.db"));
  });

  it("records the patch that made it green, and hands it to the next attempt", async () => {
    const green = await offline(() =>
      runRepairStep(dir, fixture.target("2.0.0"), { patch: CORRECT_FIX, attempt: 2, store, maxSeconds: 120 }),
    );
    if ("error" in green) throw new Error(green.error);
    expect(green.status).toBe("green");
    expect(green.recorded, "a green repair should be written back as memory").toBeDefined();

    // A fresh loop over the same package now starts with the migration already in hand.
    resetGraphCache();
    const next = await offline(() => runRepairStep(dir, fixture.target("2.0.0"), { store, maxSeconds: 120 }));
    if ("error" in next) throw new Error(next.error);
    expect(next.status).toBe("work");
    expect(next.memory.pastRepairs).toHaveLength(1);
    expect(next.task!.pastRepairs![0]!.patch).toContain("greet({ name })");
    expect(next.memory.pastRepairs[0]!.provenTests).toContain("src/banner.test.js");
  }, 300_000);

  it("records nothing for a bump that was already clean — that taught nobody anything", async () => {
    const green = await offline(() => runRepairStep(dir, fixture.target("1.0.0"), { store, maxSeconds: 120 }));
    if ("error" in green) throw new Error(green.error);
    expect(green.status).toBe("green");
    expect(green.recorded).toBeUndefined();
    expect(await recallPastRepairs(store, "greeter")).toEqual([]);
  }, 300_000);

  it("puts a pin in front of the agent BEFORE it writes a fix", async () => {
    await store.append({
      kind: "decision",
      externalId: "human:pin-greeter",
      occurredAt: "2026-01-01T00:00:00Z",
      actor: "alice",
      title: "Hold greeter at 1.x",
      payload: { origin: "human", summary: "Hold greeter at 1.x", rationale: "2.x breaks our call sites; see #812", alternatives: [], confidence: "high" },
      files: [],
    });

    const step = await offline(() => runRepairStep(dir, fixture.target("2.0.0"), { store, maxSeconds: 120 }));
    if ("error" in step) throw new Error(step.error);
    expect(step.status).toBe("work");
    // On the TASK, not merely somewhere in the response — this is what the agent reads first.
    expect(step.task!.pins).toHaveLength(1);
    expect(step.task!.pins![0]!.summary).toContain("Hold greeter at 1.x");
  }, 300_000);
});
