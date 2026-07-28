/**
 * Flaky-test detection over ingested ci_run events. A test is flaky when it is
 * non-deterministic: it both passed and failed **on the same commit** — same code, different
 * outcome — which is the one signal that can't be a real regression or a real fix. We report
 * that (with the commits where it flipped) so the sim can discount such a failure instead of
 * treating it as a hard regression. Pure aggregation over the event log; no model calls.
 *
 * Cross-commit disagreement (passed on one commit, failed on another) is NOT flakiness — that's
 * ordinary history — so we deliberately don't flag it. Detecting same-commit flips needs the
 * same commit to have been run more than once (CI retries, required-check re-runs, matrix jobs);
 * absent that evidence we say nothing, honestly.
 */
import type { KeelEvent } from "../events/store.js";
import { testKey, type StoredTestResult } from "./ingest.js";
import type { TestStatus } from "./junit.js";

export interface FlakyTest {
  key: string;
  name: string;
  file?: string;
  /** distinct commits where this test both passed and failed */
  flips: number;
  /** total non-skipped observations across the analyzed runs */
  runs: number;
  fails: number;
  passes: number;
  /** the most recent commit where it flipped */
  lastFlipSha?: string;
}

interface CiRunPayload {
  runId?: string;
  sha?: string | null;
  tests?: StoredTestResult[];
}

function isFail(status: TestStatus): boolean {
  return status === "failed" || status === "error";
}

interface PerTest {
  name: string;
  file?: string;
  fails: number;
  passes: number;
  /** sha -> the outcomes seen for this test at that commit, plus the latest time seen */
  bySha: Map<string, { pass: boolean; fail: boolean; at: string }>;
}

/**
 * Aggregate ci_run events into the tests that flip on a single commit. `runs` should be recent
 * ci_run events (newest first is fine — order doesn't matter here).
 */
export function detectFlakyTests(runs: KeelEvent[]): FlakyTest[] {
  const tests = new Map<string, PerTest>();

  for (const run of runs) {
    if (run.kind !== "ci_run") continue;
    const payload = run.payload as CiRunPayload;
    const sha = payload.sha ?? null;
    for (const t of payload.tests ?? []) {
      if (t.status === "skipped") continue;
      const key = testKey(t.file, t.name);
      let rec = tests.get(key);
      if (!rec) {
        rec = { name: t.name, ...(t.file ? { file: t.file } : {}), fails: 0, passes: 0, bySha: new Map() };
        tests.set(key, rec);
      }
      const failed = isFail(t.status);
      if (failed) rec.fails++;
      else rec.passes++;

      if (sha !== null) {
        const at = rec.bySha.get(sha) ?? { pass: false, fail: false, at: run.occurredAt };
        at.pass ||= !failed;
        at.fail ||= failed;
        if (run.occurredAt > at.at) at.at = run.occurredAt;
        rec.bySha.set(sha, at);
      }
    }
  }

  const flaky: FlakyTest[] = [];
  for (const [key, rec] of tests) {
    const flipShas = [...rec.bySha.entries()].filter(([, o]) => o.pass && o.fail);
    if (flipShas.length === 0) continue;
    const lastFlip = flipShas.reduce((a, b) => (b[1].at > a[1].at ? b : a));
    flaky.push({
      key,
      name: rec.name,
      ...(rec.file ? { file: rec.file } : {}),
      flips: flipShas.length,
      runs: rec.fails + rec.passes,
      fails: rec.fails,
      passes: rec.passes,
      lastFlipSha: lastFlip[0],
    });
  }

  flaky.sort((a, b) => b.flips - a.flips || b.fails - a.fails || a.key.localeCompare(b.key));
  return flaky;
}

/**
 * Match sets for discounting sim failures against known-flaky tests. A failure matches when its
 * (file, name) matches a flaky record that has a file, or its name matches a flaky record that
 * has no file (e.g. a pytest report) — conservative, so we never discount on a name collision
 * when file information is available on both sides.
 */
export interface FlakyMatcher {
  isFlaky(name: string, file: string | undefined): boolean;
}

export function flakyMatcher(flaky: FlakyTest[]): FlakyMatcher {
  const byFileName = new Set<string>();
  const byNameOnly = new Set<string>();
  for (const f of flaky) {
    if (f.file) byFileName.add(testKey(f.file, f.name));
    else byNameOnly.add(f.name);
  }
  return {
    isFlaky(name, file) {
      if (file && byFileName.has(testKey(file, name))) return true;
      return byNameOnly.has(name);
    },
  };
}
