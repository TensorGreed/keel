/**
 * A deterministic synthetic repo generator for the large-repo perf budget (perf.test.ts).
 *
 * Why synthetic rather than a real monorepo: the perf test needs a *known, reproducible* shape at a
 * size no public repo conveniently provides, and it needs to be able to build the same shape at two
 * scales to check that cost stays linear. A pinned clone gives one size and drifts with the upstream
 * repo; this gives any size, byte-identical every run (fixed seed, no randomness in the output).
 *
 * The shape aims at *realistic cost*, not realistic code — the properties that drive graph-build
 * time are the ones reproduced here:
 *
 *   - **TypeScript** — many small packages in an npm workspace, each module importing three earlier
 *     siblings plus an occasional cross-package import by package name. That exercises the compiler
 *     API's per-directory tsconfig lookup and the workspace package map, not just relative paths.
 *   - **Python** — packages under `src/` (so `src`-layout detection runs), relative imports plus
 *     absolute cross-package ones, and a mirrored `tests/` tree.
 *   - **Go** — packages of a dozen files, where an import targets the *package*, so one import edge
 *     fans out to every non-test file of it; plus a `_test.go` per package.
 *   - **Java** — several build modules, each with several packages of ten types. Package-as-unit
 *     adjacency is the densest edge source in keel, and module scoping is what keeps it bounded, so
 *     the module/package/type nesting is the point. Types are `@Service`-annotated with a field of a
 *     neighbouring package's type, so the Spring DI enrichment pass runs too.
 *
 * Nothing here is compiled or executed — only scanned.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface SynthCounts {
  ts: number;
  py: number;
  go: number;
  java: number;
}

/** Modules per grouping — chosen to look like real code, since group size drives edge density. */
const TS_PER_PACKAGE = 40;
const PY_PER_PACKAGE = 40;
const GO_PER_PACKAGE = 12;
const JAVA_TYPES_PER_PACKAGE = 10;
const JAVA_PACKAGES_PER_MODULE = 8;

/** Generate the repo at `root`, replacing anything there. Returns the number of files written. */
export function generateSynthRepo(root: string, counts: SynthCounts): number {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  let written = 0;
  const write = (rel: string, text: string): void => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    written++;
  };

  // These report nothing: they all write through `write`, which is what keeps the count.
  writeTypeScript(write, counts.ts);
  writePython(write, counts.py);
  writeGo(write, counts.go);
  writeJava(write, counts.java);
  return written;
}

type Write = (rel: string, text: string) => void;

function writeTypeScript(write: Write, count: number): void {
  if (count === 0) return;
  write("package.json", `${JSON.stringify({ name: "synth", private: true, workspaces: ["packages/*"] }, null, 2)}\n`);
  write(
    "tsconfig.json",
    `${JSON.stringify({ compilerOptions: { module: "nodenext", moduleResolution: "nodenext", strict: true, allowJs: true } }, null, 2)}\n`,
  );
  const packages = Math.ceil(count / TS_PER_PACKAGE);
  for (let p = 0; p < packages; p++) {
    write(`packages/pkg${p}/package.json`, `${JSON.stringify({ name: `@synth/pkg${p}`, version: "1.0.0", type: "module", main: "src/index.ts" })}\n`);
    write(`packages/pkg${p}/src/index.ts`, `export { v0 } from "./m0.js";\n`);
    const modules = Math.min(TS_PER_PACKAGE, count - p * TS_PER_PACKAGE);
    for (let i = 0; i < modules; i++) {
      const lines: string[] = [];
      const terms: string[] = [];
      for (let k = 1; k <= 3 && i - k >= 0; k++) {
        lines.push(`import { v${i - k} } from "./m${i - k}.js";`);
        terms.push(`v${i - k}`);
      }
      // Every fourth module reaches into the previous package BY NAME — the workspace resolution path.
      if (p > 0 && i % 4 === 0) {
        lines.push(`import { v0 as cross } from "@synth/pkg${p - 1}";`);
        terms.push("cross");
      }
      const sum = terms.length > 0 ? terms.join(" + ") : "0";
      write(
        `packages/pkg${p}/src/m${i}.ts`,
        `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}export const v${i}: number = ${sum} + ${i};\nexport function f${i}(a: number): number {\n  return a + v${i};\n}\n`,
      );
      if (i % 5 === 0) {
        write(
          `packages/pkg${p}/src/m${i}.test.ts`,
          `import { test, expect } from "vitest";\nimport { f${i} } from "./m${i}.js";\ntest("f${i}", () => {\n  expect(f${i}(1)).toBeGreaterThan(0);\n});\n`,
        );
      }
    }
  }
}

function writePython(write: Write, count: number): void {
  if (count === 0) return;
  const packages = Math.ceil(count / PY_PER_PACKAGE);
  for (let p = 0; p < packages; p++) {
    write(`src/pypkg${p}/__init__.py`, "");
    const modules = Math.min(PY_PER_PACKAGE, count - p * PY_PER_PACKAGE);
    for (let i = 0; i < modules; i++) {
      const imports: string[] = [];
      for (let k = 1; k <= 3 && i - k >= 0; k++) imports.push(`from .mod${i - k} import V${i - k}`);
      if (p > 0 && i % 4 === 0) imports.push(`from pypkg${p - 1}.mod0 import V0`); // absolute, src-layout
      write(`src/pypkg${p}/mod${i}.py`, `${imports.join("\n")}${imports.length > 0 ? "\n" : ""}\nV${i} = ${i}\n\n\ndef f${i}(a):\n    return a + V${i}\n`);
      if (i % 5 === 0) {
        write(`tests/pypkg${p}/test_mod${i}.py`, `from pypkg${p}.mod${i} import f${i}\n\n\ndef test_f${i}():\n    assert f${i}(1) > 0\n`);
      }
    }
  }
}

function writeGo(write: Write, count: number): void {
  if (count === 0) return;
  write("go.mod", "module example.com/synth\n\ngo 1.21\n");
  const packages = Math.ceil(count / GO_PER_PACKAGE);
  for (let p = 0; p < packages; p++) {
    const files = Math.min(GO_PER_PACKAGE, count - p * GO_PER_PACKAGE);
    for (let i = 0; i < files; i++) {
      // One file per package imports the previous package: that single import fans out to every
      // non-test file of it, which is the Go cost shape.
      const importsPrev = p > 0 && i === 0;
      write(
        `gopkg${p}/f${i}.go`,
        `package gopkg${p}\n` +
          (importsPrev ? `\nimport "example.com/synth/gopkg${p - 1}"\n` : "") +
          `\nvar V${i} = ${i}\n\nfunc F${i}(a int) int {\n\treturn a + V${i}\n}\n` +
          (importsPrev ? `\nfunc Use${p}() int {\n\treturn gopkg${p - 1}.V0\n}\n` : ""),
      );
    }
    write(`gopkg${p}/f0_test.go`, `package gopkg${p}\n\nimport "testing"\n\nfunc TestF0(t *testing.T) {\n\tif F0(1) < 1 {\n\t\tt.Fatal("bad")\n\t}\n}\n`);
  }
}

function writeJava(write: Write, count: number): void {
  if (count === 0) return;
  const perModule = JAVA_TYPES_PER_PACKAGE * JAVA_PACKAGES_PER_MODULE;
  const modules = Math.ceil(count / perModule);
  for (let m = 0; m < modules; m++) {
    write(`modules/mod${m}/pom.xml`, `<project><artifactId>mod${m}</artifactId></project>\n`);
    let remaining = Math.min(perModule, count - m * perModule);
    for (let p = 0; p < JAVA_PACKAGES_PER_MODULE && remaining > 0; p++) {
      const types = Math.min(JAVA_TYPES_PER_PACKAGE, remaining);
      remaining -= types;
      for (let i = 0; i < types; i++) {
        // A field of a neighbouring package's type: a real import edge, and an injection point for
        // the Spring DI pass to consider.
        const dep = p > 0 ? `import com.synth.mod${m}.p${p - 1}.T0;\n` : "";
        const field = p > 0 ? "\n  private final T0 dep = null;\n" : "";
        write(
          `modules/mod${m}/src/main/java/com/synth/mod${m}/p${p}/T${i}.java`,
          `package com.synth.mod${m}.p${p};\n\n${dep}import org.springframework.stereotype.Service;\n\n@Service\npublic class T${i} {\n${field}\n  public int f() {\n    return ${i};\n  }\n}\n`,
        );
      }
      write(
        `modules/mod${m}/src/test/java/com/synth/mod${m}/p${p}/T0Test.java`,
        `package com.synth.mod${m}.p${p};\n\nimport org.junit.jupiter.api.Test;\n\npublic class T0Test {\n  @Test\n  public void t() {\n    new T0().f();\n  }\n}\n`,
      );
    }
  }
}
