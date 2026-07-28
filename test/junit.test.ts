import { describe, expect, it } from "vitest";
import { parseJUnit } from "../src/ci/junit.js";

// A vitest-style report with a passing, a failing, and a skipped case; names contain ">".
const VITEST = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="vitest">
  <testsuite name="src/a.test.ts" tests="3" failures="1" skipped="1" timestamp="2021-06-01T00:00:00Z">
    <testcase classname="src/a.test.ts" name="math &gt; adds" file="src/a.test.ts" time="0.012"/>
    <testcase classname="src/a.test.ts" name="math &gt; subtracts" file="src/a.test.ts" time="0.5">
      <failure message="expected 1 to be 2">AssertionError: expected 1 to be 2</failure>
    </testcase>
    <testcase classname="src/a.test.ts" name="math &gt; wip" file="src/a.test.ts">
      <skipped/>
    </testcase>
  </testsuite>
</testsuites>`;

// A pytest-style report: single <testsuite>, classname is the module, <error>, no file attr.
const PYTEST = `<testsuite name="pytest" tests="2" errors="1">
  <testcase classname="tests.test_calc" name="test_add" time="0.001"></testcase>
  <testcase classname="tests.test_calc" name="test_div"><error message="ZeroDivisionError">traceback</error></testcase>
</testsuite>`;

describe("parseJUnit", () => {
  it("parses cases, statuses, files, and entity-decoded names", () => {
    const r = parseJUnit(VITEST);
    expect(r.suiteName).toBe("src/a.test.ts");
    expect(r.timestamp).toBe("2021-06-01T00:00:00Z");
    expect(r.tests).toHaveLength(3);

    const [pass, fail, skip] = r.tests;
    expect(pass).toMatchObject({ name: "math > adds", file: "src/a.test.ts", status: "passed", timeMs: 12 });
    expect(fail).toMatchObject({ name: "math > subtracts", status: "failed", message: "expected 1 to be 2" });
    expect(skip).toMatchObject({ name: "math > wip", status: "skipped" });
  });

  it("handles a bare <testsuite>, classname-only cases, and <error>", () => {
    const r = parseJUnit(PYTEST);
    expect(r.tests.map((t) => t.status)).toEqual(["passed", "error"]);
    expect(r.tests[0]).toMatchObject({ name: "test_add", classname: "tests.test_calc" });
    expect(r.tests[0]!.file).toBeUndefined();
    expect(r.tests[1]).toMatchObject({ name: "test_div", status: "error", message: "ZeroDivisionError" });
  });

  it("returns no tests for empty or non-JUnit XML", () => {
    expect(parseJUnit("<testsuite></testsuite>").tests).toEqual([]);
    expect(parseJUnit("not xml at all").tests).toEqual([]);
  });
});
