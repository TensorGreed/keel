/**
 * The `node --test` reporter parse, pinned against output RECORDED from two Node versions.
 *
 * This exists because of a real failure: keel's node runner attributed each failure to a file using
 * the `file` attribute of Node's junit reporter — which Node 24 emits and Node 22 does not. The
 * suite was green on the machine it was written on and failed on a different point release, with
 * failures arriving without `.file` and therefore without a `graphPath`. The reporter was already
 * pinned (`--test-reporter=junit`); what moved was a field *inside* the pinned format.
 *
 * The fix is not a different reporter — it is not depending on version-variant fields at all.
 * Attribution now comes from keel's own knowledge first (it passed the runner an explicit list of
 * test files), and from output only when that output points unambiguously at one of them. These
 * tests drive that from the recorded bytes of both versions, and assert the thing that actually
 * matters: **the Node version must not change the answer.**
 *
 * Fixtures in test/fixtures/node-test/ were produced by running the same two-test-file suite under
 * each version; RECORDED.txt names them. The recording worktree was /tmp/keel-nodetest-wt.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { attributeToRanTest, nodeTestResults } from "../src/simulate/sandbox.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "node-test");
/** The directory the fixtures were recorded in — the "worktree" for these parses. */
const WORKTREE = "/tmp/keel-nodetest-wt";
const recorded = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), "utf8");

const TWO_FILES = ["a.test.js", "b.test.js"];

describe("node --test junit output, across Node versions", () => {
  it("Node 22 emits no `file` attribute at all — the regression this guards", () => {
    // Pinning the finding itself: if a future Node 22 patch starts emitting it, this fixture is
    // stale and someone should re-record rather than assume the problem went away.
    expect(recorded("junit-node22-two-files.xml")).not.toContain("file=");
    expect(recorded("junit-node24-two-files.xml")).toContain("file=");
  });

  it("attributes every failure from a single-file run without reading the output at all", () => {
    // The by-construction case: one file went in, so everything that failed came from it. This is
    // exactly where Node 22 used to yield nothing.
    const result = nodeTestResults(recorded("junit-node22-one-file.xml"), WORKTREE, ["a.test.js"]);
    expect(result.passed).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.file).toBe("a.test.js");
    expect(result.failures[0]!.name).toBe("a fails");
    expect(result.failures[0]!.message).toBe("1 == 2");
  });

  it("attributes a multi-file run on Node 22, from the stack, with no `file` attribute available", () => {
    const result = nodeTestResults(recorded("junit-node22-two-files.xml"), WORKTREE, TWO_FILES);
    expect(result.passed).toBe(2);
    expect(result.failures.map((f) => [f.name, f.file])).toEqual([
      ["a fails", "a.test.js"],
      ["b fails", "b.test.js"],
    ]);
  });

  it("attributes the same multi-file run on Node 24, where the attribute IS present", () => {
    const result = nodeTestResults(recorded("junit-node24-two-files.xml"), WORKTREE, TWO_FILES);
    expect(result.failures.map((f) => [f.name, f.file])).toEqual([
      ["a fails", "a.test.js"],
      ["b fails", "b.test.js"],
    ]);
  });

  it("reads both versions to the SAME answer — the version must not change the result", () => {
    const shape = (xml: string): unknown =>
      nodeTestResults(xml, WORKTREE, TWO_FILES).failures.map((f) => ({ name: f.name, file: f.file, message: f.message }));
    expect(shape(recorded("junit-node22-two-files.xml"))).toEqual(shape(recorded("junit-node24-two-files.xml")));
  });

  it("carries the trace through on both versions, so a reader still gets the stack", () => {
    for (const fixture of ["junit-node22-two-files.xml", "junit-node24-two-files.xml"]) {
      const [first] = nodeTestResults(recorded(fixture), WORKTREE, TWO_FILES).failures;
      expect(first!.trace, fixture).toContain("AssertionError");
      expect(first!.trace, fixture).toContain("a.test.js");
    }
  });
});

describe("attributeToRanTest — our own list first, output only when unambiguous", () => {
  it("uses the single file we asked for, whatever the output says", () => {
    // Even a reporter naming a different file loses to what keel actually ran.
    expect(attributeToRanTest(["only.test.js"], "/wt", { file: "/wt/somewhere-else.js" })).toBe("only.test.js");
    expect(attributeToRanTest(["only.test.js"], "/wt", {})).toBe("only.test.js");
  });

  it("resolves a reported absolute path against the list", () => {
    expect(attributeToRanTest(TWO_FILES, WORKTREE, { file: `${WORKTREE}/b.test.js` })).toBe("b.test.js");
  });

  it("falls back to a UNIQUE hit in the stack", () => {
    expect(attributeToRanTest(TWO_FILES, WORKTREE, { trace: `at x (${WORKTREE}/b.test.js:4:1)` })).toBe("b.test.js");
  });

  it("matches a stack that spells paths with backslashes — the Windows shape", () => {
    // On a Node version whose junit reporter omits `file`, the stack is the ONLY attribution route,
    // and on Windows it is written with backslashes while every graph key is posix. Reproducible
    // here because the trace is data, not a platform behaviour.
    const trace = "at TestContext.<anonymous> (C:\\keel\\wt\\b.test.js:4:32)";
    expect(attributeToRanTest(TWO_FILES, "C:\\keel\\wt", { trace })).toBe("b.test.js");
  });

  it("still respects a path boundary after normalizing separators", () => {
    const trace = "at x (C:\\keel\\wt\\xa.test.js:1:1)";
    expect(attributeToRanTest(["a.test.js", "other.test.js"], "C:\\keel\\wt", { trace })).toBeUndefined();
  });

  it("refuses to guess when the stack names more than one of them", () => {
    // Two candidates is not a fact. A failure pinned to the wrong file sends a reader — or an
    // agent — to rewrite code that was never involved.
    const trace = `at x (${WORKTREE}/a.test.js:1:1)\n at y (${WORKTREE}/b.test.js:2:2)`;
    expect(attributeToRanTest(TWO_FILES, WORKTREE, { trace })).toBeUndefined();
  });

  it("matches on a path boundary, so a.test.js is not found inside xa.test.js", () => {
    expect(attributeToRanTest(["a.test.js", "other.test.js"], WORKTREE, { trace: `at x (${WORKTREE}/xa.test.js:1:1)` })).toBeUndefined();
  });

  it("returns nothing when it knows nothing", () => {
    expect(attributeToRanTest([], "/wt", { file: "/wt/a.js" })).toBeUndefined();
    expect(attributeToRanTest(TWO_FILES, WORKTREE, {})).toBeUndefined();
  });
});
