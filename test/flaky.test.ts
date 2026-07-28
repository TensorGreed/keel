import { describe, expect, it } from "vitest";
import type { KeelEvent } from "../src/events/store.js";
import { detectFlakyTests, flakyMatcher } from "../src/ci/flaky.js";
import type { StoredTestResult } from "../src/ci/ingest.js";

let seq = 0;
function run(sha: string, tests: StoredTestResult[]): KeelEvent {
  return { kind: "ci_run", externalId: `ci:${sha}:${seq}`, occurredAt: `2021-06-01T00:00:0${seq++}Z`, payload: { sha, tests } };
}
const pass = (name: string, file?: string): StoredTestResult => ({ name, ...(file ? { file } : {}), status: "passed" });
const fail = (name: string, file?: string): StoredTestResult => ({ name, ...(file ? { file } : {}), status: "failed" });

describe("detectFlakyTests", () => {
  it("flags a test that passed and failed on the same commit", () => {
    const flaky = detectFlakyTests([run("s1", [pass("t", "a.test.ts")]), run("s1", [fail("t", "a.test.ts")])]);
    expect(flaky).toHaveLength(1);
    expect(flaky[0]).toMatchObject({ key: "a.test.ts::t", name: "t", file: "a.test.ts", flips: 1, fails: 1, passes: 1, lastFlipSha: "s1" });
  });

  it("does NOT flag cross-commit disagreement (that's ordinary history, not flakiness)", () => {
    expect(detectFlakyTests([run("s1", [pass("t", "a.test.ts")]), run("s2", [fail("t", "a.test.ts")])])).toEqual([]);
  });

  it("does NOT flag consistent pass or consistent fail", () => {
    expect(detectFlakyTests([run("s1", [pass("t")]), run("s1", [pass("t")])])).toEqual([]);
    expect(detectFlakyTests([run("s1", [fail("t")]), run("s1", [fail("t")])])).toEqual([]);
  });

  it("ignores skipped observations", () => {
    const flaky = detectFlakyTests([
      run("s1", [pass("t", "a.test.ts")]),
      run("s1", [{ name: "t", file: "a.test.ts", status: "skipped" }]),
    ]);
    expect(flaky).toEqual([]); // one pass + one skip is not a flip
  });

  it("counts flips across multiple commits and ranks by them", () => {
    const flaky = detectFlakyTests([
      run("s1", [pass("hot", "h.test.ts"), pass("warm", "w.test.ts")]),
      run("s1", [fail("hot", "h.test.ts"), pass("warm", "w.test.ts")]),
      run("s2", [pass("hot", "h.test.ts")]),
      run("s2", [fail("hot", "h.test.ts")]),
    ]);
    expect(flaky.map((f) => f.name)).toEqual(["hot"]); // warm never flipped
    expect(flaky[0]!.flips).toBe(2); // flipped on s1 and s2
  });
});

describe("flakyMatcher", () => {
  it("matches by file+name, and by name only when the record has no file", () => {
    const withFile = flakyMatcher([{ key: "a.test.ts::t", name: "t", file: "a.test.ts", flips: 1, runs: 2, fails: 1, passes: 1 }]);
    expect(withFile.isFlaky("t", "a.test.ts")).toBe(true);
    expect(withFile.isFlaky("t", "other.ts")).toBe(false); // file known -> no loose name match
    expect(withFile.isFlaky("t", undefined)).toBe(false);

    const noFile = flakyMatcher([{ key: "t", name: "t", flips: 1, runs: 2, fails: 1, passes: 1 }]);
    expect(noFile.isFlaky("t", "anywhere.ts")).toBe(true); // name-only fallback
  });
});
