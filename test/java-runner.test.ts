import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { preflight } from "../src/simulate/preflight.js";
import { javaClassName, javaResults } from "../src/simulate/sandbox.js";
import { resetGraphCache } from "../src/graph/cache.js";
import { initGraphScanners } from "../src/graph/scanners.js";

// The Java sandbox runner. The report-parsing/attribution logic is a pure function (javaResults),
// unit-tested here against a synthetic Surefire report — no JDK required. The runner-unavailable
// path is asserted deterministically. The executed path needs Maven + a JDK, so it skips cleanly
// when absent.

function hasMaven(): boolean {
  try {
    execFileSync("mvn", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const MAVEN = hasMaven();

function git(dir: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "D", GIT_AUTHOR_EMAIL: "d@e.com", GIT_COMMITTER_NAME: "D", GIT_COMMITTER_EMAIL: "d@e.com",
    },
  });
}
function write(dir: string, rel: string, contents: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), contents);
}

/** A single-module Maven repo: Service (returns 13) + a same-package ServiceTest that asserts it. */
function makeMavenRepo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "keel-java-"));
  git(d, ["init", "-b", "main"]);
  write(d, ".gitignore", "target/\n.keel/\n");
  write(d, "pom.xml", "<project><groupId>com.example</groupId><artifactId>app</artifactId><version>1.0</version></project>\n");
  write(d, "src/main/java/com/example/app/Service.java", "package com.example.app;\n\npublic class Service {\n  public int run() { return 13; }\n}\n");
  // ServiceTest is the same package as Service, referencing it WITH NO import — the adjacency case.
  write(
    d,
    "src/test/java/com/example/app/ServiceTest.java",
    "package com.example.app;\n\nimport org.junit.Test;\n\npublic class ServiceTest {\n  @Test\n  public void testRun() {\n    if (new Service().run() != 13) throw new AssertionError();\n  }\n}\n",
  );
  git(d, ["add", "-A"]);
  git(d, ["commit", "-qm", "init"]);
  return d;
}
// Break Service so ServiceTest would fail.
const BREAK = `diff --git a/src/main/java/com/example/app/Service.java b/src/main/java/com/example/app/Service.java
--- a/src/main/java/com/example/app/Service.java
+++ b/src/main/java/com/example/app/Service.java
@@ -1,5 +1,5 @@
 package com.example.app;

 public class Service {
-  public int run() { return 13; }
+  public int run() { return 7; }
 }
`;

const TEST_FILE = "src/test/java/com/example/app/ServiceTest.java";

let dir: string;
beforeAll(async () => {
  await initGraphScanners();
});
beforeEach(() => {
  resetGraphCache();
  dir = makeMavenRepo();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("java runner — pure report parsing (always)", () => {
  it("derives a fully-qualified class name from a selected test file path", () => {
    expect(javaClassName("src/test/java/com/example/app/ServiceTest.java")).toBe("com.example.app.ServiceTest");
    expect(javaClassName("web/src/test/java/com/example/web/FooTest.java")).toBe("com.example.web.FooTest");
  });

  it("normalizes a Surefire report into counts and failures, attributing the test file + trace", () => {
    const surefire = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.app.ServiceTest" tests="2" failures="1" errors="0" skipped="0" time="0.05">
  <testcase name="testPasses" classname="com.example.app.ServiceTest" time="0.01"/>
  <testcase name="testRun" classname="com.example.app.ServiceTest" time="0.02">
    <failure message="expected:&lt;13&gt; but was:&lt;7&gt;" type="java.lang.AssertionError">java.lang.AssertionError: expected:&lt;13&gt; but was:&lt;7&gt;
	at com.example.app.ServiceTest.testRun(ServiceTest.java:8)</failure>
  </testcase>
</testsuite>`;
    const fileForClass = new Map([["com.example.app.ServiceTest", TEST_FILE]]);
    const r = javaResults([surefire], fileForClass);
    expect(r.passed).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.total).toBe(2);
    const f = r.failures[0]!;
    expect(f.name).toBe("testRun");
    expect(f.file).toBe(TEST_FILE); // attributed via the junit classname → selected file
    expect(f.message).toBe("expected:<13> but was:<7>");
    expect(f.trace).toContain("ServiceTest.java:8"); // the stack, carried as trace
  });
});

describe("java runner — orchestration via a stub wrapper (always)", () => {
  // Exercise the whole runner end-to-end without a real toolchain: a ./mvnw wrapper that just writes
  // a Surefire report and exits. This proves the wrapper is preferred and invoked, the report is
  // collected from target/surefire-reports, and the failure is attributed back to the test file —
  // deterministically, on any host (like the pytest stub-interpreter test).
  it("prefers the wrapper, collects the Surefire report, and attributes the failure to the test", async () => {
    const repo = makeMavenRepo();
    try {
      const wrapper = `#!/bin/sh
mkdir -p target/surefire-reports
cat > target/surefire-reports/TEST-com.example.app.ServiceTest.xml <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.app.ServiceTest" tests="1" failures="1" errors="0" skipped="0">
  <testcase name="testRun" classname="com.example.app.ServiceTest" time="0.01">
    <failure message="expected 13 but was 7" type="java.lang.AssertionError">java.lang.AssertionError
\tat com.example.app.ServiceTest.testRun(ServiceTest.java:8)</failure>
  </testcase>
</testsuite>
XML
exit 1
`;
      write(repo, "mvnw", wrapper);
      fs.chmodSync(path.join(repo, "mvnw"), 0o755);
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-qm", "add stub wrapper"]);

      const pf = await preflight(repo, { diff: BREAK });
      if ("error" in pf) throw new Error(pf.error);
      expect(pf.executed.runner).toBe("mvn");
      expect(pf.executed.status).toBe("failed");
      const failure = pf.executed.failures.find((f) => f.test === "testRun");
      expect(failure).toBeDefined();
      expect(failure!.file).toBe(TEST_FILE); // attributed via the report's classname
      expect(failure!.graphPath).toEqual([TEST_FILE, "src/main/java/com/example/app/Service.java"]);
      expect(failure!.trace).toContain("ServiceTest.java:8");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);

  /** Install a ./mvnw that prints `output` and exits non-zero without writing any report. */
  function withStubWrapperOutput(repo: string, output: string): void {
    write(repo, "mvnw", `#!/bin/sh\ncat <<'OUT'\n${output}\nOUT\nexit 1\n`);
    fs.chmodSync(path.join(repo, "mvnw"), 0o755);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "add stub wrapper"]);
  }

  it("surfaces a source compile error as an executed failure carrying the compiler output", async () => {
    const repo = makeMavenRepo();
    try {
      // No report + a compile-error signature → the build compiled the change and it failed; that IS
      // the executed result (same rule as Go), a failure with the compiler output — not a crash.
      withStubWrapperOutput(repo, "[INFO] BUILD FAILURE\n[ERROR] COMPILATION ERROR :\n[ERROR] Service.java:[4,20] cannot find symbol");
      const pf = await preflight(repo, { diff: BREAK });
      if ("error" in pf) throw new Error(pf.error);
      expect(pf.executed.status).toBe("failed");
      expect(pf.executed.runner).toBe("mvn");
      const evidence = `${pf.executed.output ?? ""}\n${pf.executed.failures.map((f) => `${f.message}\n${f.trace ?? ""}`).join("\n")}`;
      expect(evidence).toContain("cannot find symbol");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);

  it("reports environment-error (not a failure) when the toolchain can't be prepared", async () => {
    const repo = makeMavenRepo();
    try {
      // A missing JDK / unresolved dependency never compiled the change — an environment fault.
      withStubWrapperOutput(repo, "[INFO] BUILD FAILURE\n[ERROR] No compiler is provided in this environment. Perhaps you are running on a JRE rather than a JDK?");
      const pf = await preflight(repo, { diff: BREAK });
      if ("error" in pf) throw new Error(pf.error);
      expect(pf.executed.status).toBe("environment-error");
      expect(pf.executed.runner).toBe("mvn");
      expect(pf.executed.error).toMatch(/build environment could not be prepared/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("java runner — unavailable path (always, no build tool here)", () => {
  it.skipIf(MAVEN)("reports runner-unavailable when no build tool is installed, and still selects the test", async () => {
    const pf = await preflight(dir, { diff: BREAK });
    if ("error" in pf) throw new Error(pf.error);
    // The test is selected across the same-package adjacency (no import between Service and its test).
    expect(pf.testsSelected).toEqual([TEST_FILE]);
    expect(pf.executed.status).toBe("runner-unavailable");
    expect(pf.executed.error).toMatch(/mvn is not available|no Java build tool/);
  }, 60_000);
});

describe.skipIf(!MAVEN)("java runner — executed path (host Maven)", () => {
  it("runs the selected test class under Maven and reports the failure with a graph path", async () => {
    const pf = await preflight(dir, { diff: BREAK });
    if ("error" in pf) throw new Error(pf.error);
    expect(pf.executed.status).toBe("failed");
    expect(pf.executed.runner).toBe("mvn");
    const failure = pf.executed.failures.find((f) => f.test === "testRun");
    expect(failure).toBeDefined();
    expect(failure!.file).toBe(TEST_FILE);
    expect(failure!.graphPath?.[0]).toBe(TEST_FILE);
  }, 300_000);

  it("passes a benign change", async () => {
    const benign = BREAK.replace("return 7;", "return 12 + 1;");
    const pf = await preflight(dir, { diff: benign });
    if ("error" in pf) throw new Error(pf.error);
    expect(pf.executed.status).toBe("passed");
    expect(pf.executed.passed).toBeGreaterThanOrEqual(1);
  }, 300_000);
});
