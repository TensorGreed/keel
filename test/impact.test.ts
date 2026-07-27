import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getImpact, type ImpactResult } from "../src/simulate/impact.js";
import { loadGraph, resetGraphCache } from "../src/graph/cache.js";

function git(dir: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Dev",
      GIT_AUTHOR_EMAIL: "dev@example.com",
      GIT_COMMITTER_NAME: "Dev",
      GIT_COMMITTER_EMAIL: "dev@example.com",
      GIT_AUTHOR_DATE: "2021-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2021-01-01T00:00:00Z",
    },
  });
}

function write(dir: string, rel: string, contents: string): void {
  const target = path.join(dir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

/**
 * lib exports two independent functions; three files import it three ways.
 * helper exports pub, which calls an unexported helper.
 */
function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-impact-"));
  git(dir, ["init", "-b", "main"]);
  write(dir, ".gitignore", ".keel/\n");
  write(dir, "lib.ts", "export function alpha() {\n  return 1;\n}\nexport function beta() {\n  return 2;\n}\n");
  write(dir, "usesAlpha.ts", 'import { alpha } from "./lib.js";\nexport const a = alpha();\n');
  write(dir, "usesBeta.ts", 'import { beta } from "./lib.js";\nexport const b = beta();\n');
  // The namespace object escapes (returned whole), so usage is "*": any change impacts it.
  write(dir, "usesStar.ts", 'import * as lib from "./lib.js";\nexport function all() {\n  return lib;\n}\n');
  write(dir, "helper.ts", "function secret() {\n  return 42;\n}\nexport function pub() {\n  return secret();\n}\n");
  write(dir, "usesPub.ts", 'import { pub } from "./helper.js";\nexport const p = pub();\n');
  write(dir, "README.md", "# Keel fixture\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "init"]);
  return dir;
}

function ok(result: ImpactResult | { error: string }): ImpactResult {
  if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
  return result;
}

function narrowedFiles(result: ImpactResult): string[] {
  return result.impactedNarrowed.map((n) => n.file).sort();
}

const DEP_FILES = ["usesAlpha.ts", "usesBeta.ts", "usesStar.ts"];

describe("diff -> impacted subgraph", () => {
  let dir: string;

  beforeAll(() => {
    dir = initRepo();
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    resetGraphCache();
  });

  it("narrows a single-export change to the dependents that use it", async () => {
    const diff = `diff --git a/lib.ts b/lib.ts
--- a/lib.ts
+++ b/lib.ts
@@ -1,6 +1,6 @@
 export function alpha() {
-  return 1;
+  return 10;
 }
 export function beta() {
   return 2;
`;
    const result = ok(await getImpact(dir, { diff }));
    expect(result.changedSymbols["lib.ts"]).toEqual(["alpha"]);
    // File-level blast radius is every dependent...
    expect(result.impactedFiles).toEqual(DEP_FILES);
    // ...but narrowing drops usesBeta (uses only beta); usesStar stays (namespace import).
    expect(narrowedFiles(result)).toEqual(["usesAlpha.ts", "usesStar.ts"]);
    expect(result.paths["usesAlpha.ts"]).toEqual(["usesAlpha.ts", "lib.ts"]);
  });

  it("keeps a namespace-import dependent impacted when the other export changes", async () => {
    const diff = `diff --git a/lib.ts b/lib.ts
--- a/lib.ts
+++ b/lib.ts
@@ -1,6 +1,6 @@
 export function alpha() {
   return 1;
 }
 export function beta() {
-  return 2;
+  return 20;
 }
`;
    const result = ok(await getImpact(dir, { diff }));
    expect(result.changedSymbols["lib.ts"]).toEqual(["beta"]);
    // usesBeta (named) and usesStar (namespace) impacted; usesAlpha dropped.
    expect(narrowedFiles(result)).toEqual(["usesBeta.ts", "usesStar.ts"]);
  });

  it("stays conservative when an unexported helper changes", async () => {
    const diff = `diff --git a/helper.ts b/helper.ts
--- a/helper.ts
+++ b/helper.ts
@@ -1,6 +1,6 @@
 function secret() {
-  return 42;
+  return 43;
 }
 export function pub() {
   return secret();
`;
    const result = ok(await getImpact(dir, { diff }));
    // The helper resolves through the intra-file closure to the exports that use it (pub),
    // rather than going fully opaque — pub's own lines weren't touched, but its consumer
    // is still impacted because pub calls secret.
    expect(result.changedSymbols["helper.ts"]).toEqual(["pub"]);
    expect(narrowedFiles(result)).toEqual(["usesPub.ts"]);
  });

  it("treats a rename as impacting the old path's dependents", async () => {
    const diff = `diff --git a/lib.ts b/lib2.ts
similarity index 100%
rename from lib.ts
rename to lib2.ts
`;
    const result = ok(await getImpact(dir, { diff }));
    expect(result.changedFiles).toContainEqual({
      path: "lib2.ts",
      status: "renamed",
      oldPath: "lib.ts",
      inGraph: true,
    });
    expect(result.impactedFiles).toEqual(DEP_FILES);
    expect(narrowedFiles(result)).toEqual(DEP_FILES);
  });

  it("treats a deletion as impacting its dependents by definition", async () => {
    const diff = `diff --git a/helper.ts b/helper.ts
deleted file mode 100644
--- a/helper.ts
+++ /dev/null
@@ -1,6 +0,0 @@
-function secret() {
-  return 42;
-}
-export function pub() {
-  return secret();
-}
`;
    const result = ok(await getImpact(dir, { diff }));
    expect(result.changedFiles).toContainEqual({ path: "helper.ts", status: "deleted", inGraph: true });
    expect(result.changedSymbols["helper.ts"]).toEqual(["*"]);
    expect(result.impactedFiles).toEqual(["usesPub.ts"]);
    expect(result.paths["usesPub.ts"]).toEqual(["usesPub.ts", "helper.ts"]);
  });

  it("reports a new file as changed but non-propagating", async () => {
    const diff = `diff --git a/newmod.ts b/newmod.ts
new file mode 100644
--- /dev/null
+++ b/newmod.ts
@@ -0,0 +1 @@
+export const fresh = 1;
`;
    const result = ok(await getImpact(dir, { diff }));
    expect(result.changedFiles).toContainEqual({ path: "newmod.ts", status: "added", inGraph: true });
    expect(result.impactedFiles).toEqual([]);
    expect(result.impactedNarrowed).toEqual([]);
  });

  it("reports a non-source change as non-propagating", async () => {
    const diff = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-# Keel fixture
+# Keel fixture!
`;
    const result = ok(await getImpact(dir, { diff }));
    expect(result.changedFiles).toContainEqual({ path: "README.md", status: "modified", inGraph: false });
    expect(result.impactedFiles).toEqual([]);
  });

  it("returns an error for a malformed diff", async () => {
    const result = await getImpact(dir, { diff: "diff --git a/lib.ts b/lib.ts\n@@ not a hunk @@\n" });
    expect("error" in result).toBe(true);
  });
});

describe("impact from the working tree", () => {
  let dir: string;

  beforeEach(() => {
    resetGraphCache();
  });
  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("uses uncommitted changes when no diff is given", async () => {
    dir = initRepo();
    resetGraphCache();
    await loadGraph(dir); // warm the disk cache at HEAD so the baseline is exact

    // Uncommitted edit: change only alpha's body.
    write(dir, "lib.ts", "export function alpha() {\n  return 100;\n}\nexport function beta() {\n  return 2;\n}\n");
    resetGraphCache();

    const result = ok(await getImpact(dir));
    expect(result.changedFiles).toContainEqual({ path: "lib.ts", status: "modified", inGraph: true });
    expect(result.changedSymbols["lib.ts"]).toEqual(["alpha"]);
    expect(narrowedFiles(result)).toEqual(["usesAlpha.ts", "usesStar.ts"]);
  });
});

// Regression: a change to one declaration must also flag exports that reference it
// internally (the intra-file closure). Working-tree mode: git authors the diff, disk is
// the new content.
describe("intra-file reference closure", () => {
  const repos: string[] = [];

  afterAll(() => {
    for (const dir of repos) fs.rmSync(dir, { recursive: true, force: true });
  });

  function repoWith(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-closure-"));
    repos.push(dir);
    git(dir, ["init", "-b", "main"]);
    write(dir, ".gitignore", ".keel/\n");
    for (const [rel, contents] of Object.entries(files)) write(dir, rel, contents);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "init"]);
    return dir;
  }

  async function impactAfterEdit(dir: string, edits: Record<string, string>): Promise<ImpactResult> {
    resetGraphCache();
    await loadGraph(dir); // warm the baseline at HEAD
    for (const [rel, contents] of Object.entries(edits)) write(dir, rel, contents);
    resetGraphCache();
    return ok(await getImpact(dir));
  }

  it("flags an export that internally calls a changed export (reportFor/transitiveDependents)", async () => {
    const dir = repoWith({
      "graph.ts":
        "export function transitiveDependents() {\n  const seen = new Set();\n  seen.delete(\"x\");\n  return [...seen];\n}\nexport function reportFor() {\n  return transitiveDependents();\n}\n",
      "consumer.ts": 'import { reportFor } from "./graph.js";\nexport const r = reportFor();\n',
    });
    // Delete the `seen.delete("x")` line inside transitiveDependents.
    const result = await impactAfterEdit(dir, {
      "graph.ts":
        "export function transitiveDependents() {\n  const seen = new Set();\n  return [...seen];\n}\nexport function reportFor() {\n  return transitiveDependents();\n}\n",
    });
    // The change to transitiveDependents also changes reportFor.
    expect(result.changedSymbols["graph.ts"]).toEqual(["reportFor", "transitiveDependents"]);
    // consumer imports only reportFor, yet is impacted.
    expect(narrowedFiles(result)).toEqual(["consumer.ts"]);
  });

  it("routes a touched helper only to the exports that use it", async () => {
    const dir = repoWith({
      "helpers.ts":
        "function helper() {\n  return 1;\n}\nexport function usesHelper() {\n  return helper();\n}\nexport function independent() {\n  return 2;\n}\n",
      "a.ts": 'import { usesHelper } from "./helpers.js";\nexport const x = usesHelper();\n',
      "b.ts": 'import { independent } from "./helpers.js";\nexport const y = independent();\n',
    });
    const result = await impactAfterEdit(dir, {
      "helpers.ts":
        "function helper() {\n  return 11;\n}\nexport function usesHelper() {\n  return helper();\n}\nexport function independent() {\n  return 2;\n}\n",
    });
    // Only usesHelper reaches the helper; independent (and its consumer) stay out.
    expect(result.changedSymbols["helpers.ts"]).toEqual(["usesHelper"]);
    expect(narrowedFiles(result)).toEqual(["a.ts"]);
  });

  it("follows a re-export chain (export { local })", async () => {
    const dir = repoWith({
      "mod.ts": "function core() {\n  return 1;\n}\nexport { core };\n",
      "c.ts": 'import { core } from "./mod.js";\nexport const z = core();\n',
    });
    const result = await impactAfterEdit(dir, {
      "mod.ts": "function core() {\n  return 2;\n}\nexport { core };\n",
    });
    expect(result.changedSymbols["mod.ts"]).toEqual(["core"]);
    expect(narrowedFiles(result)).toEqual(["c.ts"]);
  });
});
