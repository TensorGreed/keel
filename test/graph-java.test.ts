import { beforeAll, describe, expect, it } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFileGraph, reportFor, transitiveDependents, type FileGraph } from "../src/graph/dependencies.js";
import { initJavaScanner } from "../src/graph/java-scanner.js";

// Java graph analysis via the web-tree-sitter scanner. buildFileGraph is synchronous but the Java
// parser needs a one-time async init first. These resolver/scanner tests never invoke a build tool,
// so they always run (no JDK required).
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const M = "src/main/java/com/example";
const T = "src/test/java/com/example";

beforeAll(async () => {
  await initJavaScanner();
});

describe("java: single-module Maven, import forms + same-package adjacency", () => {
  let g: FileGraph;
  beforeAll(() => {
    g = buildFileGraph(path.join(fixtures, "java-maven"));
  });

  it("resolves a single-type import to the one file that declares the type", () => {
    // `import com.example.util.Helper;`
    expect(reportFor(g, `${M}/app/Service.java`).dependencies).toContain(`${M}/util/Helper.java`);
  });

  it("resolves an on-demand import to every file of the package, pulling the whole module (*)", () => {
    // `import com.example.util.*;` reaches Helper AND Constants.
    const r = reportFor(g, `${M}/app/Service.java`);
    expect(r.dependencies).toContain(`${M}/util/Helper.java`);
    expect(r.dependencies).toContain(`${M}/util/Constants.java`);
    expect(r.importsFrom[`${M}/util/Constants.java`]).toContain("*");
  });

  it("resolves a static import to the member's declaring type", () => {
    // `import static com.example.util.Constants.MAX;` → Constants.java, symbol MAX.
    expect(reportFor(g, `${M}/app/Service.java`).importsFrom[`${M}/util/Constants.java`]).toContain("MAX");
  });

  it("links same-package types with NO import statement (the adjacency model)", () => {
    // Service and Support share package com.example.app and reference each other WITHOUT importing —
    // an import-only graph would miss this entirely. Modelled as one unit: mutual adjacency.
    expect(reportFor(g, `${M}/app/Service.java`).dependencies).toContain(`${M}/app/Support.java`);
    expect(reportFor(g, `${M}/app/Support.java`).dependencies).toContain(`${M}/app/Service.java`);
  });

  it("reaches a same-package test across source roots (src/test/java ↔ src/main/java)", () => {
    // ServiceTest is package com.example.app under src/test/java; it uses Service with no import.
    // The adjacency is package-based, not directory-based, so the test still couples to the code.
    expect(reportFor(g, `${T}/app/ServiceTest.java`).dependencies).toContain(`${M}/app/Service.java`);
    expect(reportFor(g, `${M}/app/Service.java`).dependents).toContain(`${T}/app/ServiceTest.java`);
  });

  it("exports public top-level types only", () => {
    expect(reportFor(g, `${M}/app/Service.java`).exports).toEqual(["Service"]);
    expect(reportFor(g, `${M}/util/Helper.java`).exports).toEqual(["Helper"]);
  });

  it("does not draw an edge for a JDK / third-party import", () => {
    // `import org.junit.Test;` resolves to nothing in-repo — no dangling edge.
    for (const dep of reportFor(g, `${T}/app/ServiceTest.java`).dependencies) {
      expect(dep.startsWith("src/")).toBe(true);
    }
  });

  it("selects the test through the blast radius when a util type changes", () => {
    // Helper -> Service (import) -> ServiceTest (same-package). Changing Helper reaches the test.
    expect(transitiveDependents(g, `${M}/util/Helper.java`)).toContain(`${T}/app/ServiceTest.java`);
  });
});

describe("java: two-module Maven build — scoping to the module, not the repo", () => {
  let g: FileGraph;
  beforeAll(() => {
    g = buildFileGraph(path.join(fixtures, "java-maven-multi"));
  });

  it("does NOT resolve a cross-module import (each child module is its own scope)", () => {
    // web/Server imports com.example.core.Engine, but core is a sibling module — resolving it here
    // would be the same over-reach that fuses unrelated same-package projects. True cross-module
    // deps arrive later via the module's declared dependencies; for now, no edge.
    const server = "web/src/main/java/com/example/web/Server.java";
    const engine = "core/src/main/java/com/example/core/Engine.java";
    expect(reportFor(g, server).dependencies).not.toContain(engine);
    expect(reportFor(g, engine).dependents).toEqual([]);
  });

  it("still fuses same-package siblings WITHIN a module (adjacency intact)", () => {
    // Server and Router are both com.example.web in the web module — same-package, no import.
    const server = "web/src/main/java/com/example/web/Server.java";
    const router = "web/src/main/java/com/example/web/Router.java";
    expect(reportFor(g, server).dependencies).toEqual([router]);
    expect(reportFor(g, router).dependencies).toEqual([server]);
  });
});

describe("java: samples monorepo — a shared package name across unrelated projects is not fused", () => {
  // The CipherTrust cold-start finding: 50+ standalone samples all declare `package com.example`.
  // Repo-global adjacency fused them into one 170-file unit. Adjacency is now scoped to the module.
  for (const [label, fixture] of [
    ["no build files (source-root scope)", "java-samples-nobuild"],
    ["with build files (build-file scope)", "java-samples-build"],
  ] as const) {
    it(`keeps two same-package projects separate — ${label}`, () => {
      const g = buildFileGraph(path.join(fixtures, fixture));
      const appA = "projectA/src/main/java/com/example/AppA.java";
      const helperA = "projectA/src/main/java/com/example/HelperA.java";
      const appB = "projectB/src/main/java/com/example/AppB.java";
      const helperB = "projectB/src/main/java/com/example/HelperB.java";
      // Same-package adjacency still works WITHIN a project.
      expect(reportFor(g, appA).dependencies).toEqual([helperA]);
      // But it does NOT reach into the other project's `com.example`.
      expect(reportFor(g, appA).dependencies).not.toContain(appB);
      expect(reportFor(g, appA).dependencies).not.toContain(helperB);
      // No file in project A carries a project-B file in its blast radius (and vice-versa).
      expect(transitiveDependents(g, helperA).some((f) => f.startsWith("projectB/"))).toBe(false);
      expect(transitiveDependents(g, helperB).some((f) => f.startsWith("projectA/"))).toBe(false);
    });
  }
});

describe("java: Gradle single-module", () => {
  it("uses the same src/main/java · src/test/java convention and package adjacency", () => {
    const g = buildFileGraph(path.join(fixtures, "java-gradle"));
    const widget = "src/main/java/com/example/g/Widget.java";
    const test = "src/test/java/com/example/g/WidgetTest.java";
    expect(reportFor(g, test).dependencies).toEqual([widget]); // no import; adjacency across roots
    expect(reportFor(g, widget).dependents).toEqual([test]);
  });
});
