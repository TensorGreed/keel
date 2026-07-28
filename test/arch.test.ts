import { describe, expect, it } from "vitest";
import type { FileGraph } from "../src/graph/dependencies.js";
import { findForbiddenEdges, gatingViolations, describeViolation } from "../src/trust/arch.js";
import { parsePolicy, type ForbiddenImport } from "../src/trust/policy.js";

/** Minimal graph from an import map (importer -> imported[]). */
function graphOf(edges: Record<string, string[]>): FileGraph {
  const imports = new Map<string, Set<string>>();
  for (const [f, deps] of Object.entries(edges)) imports.set(f, new Set(deps));
  return { imports, importedBy: new Map(), importSymbols: new Map(), exportsOf: new Map(), files: [...imports.keys()] };
}

const RULE: ForbiddenImport = { from: "src/ui/**", to: "src/db/**", reason: "the UI must go through the service layer" };

describe("findForbiddenEdges + gatingViolations (rule matrix)", () => {
  it("flags an edge whose importer a change introduced or retains", () => {
    // Post-change graph: ui/page.ts imports db/client.ts. Whether the change added this edge
    // (introduced) or merely kept it (retained), it's present with a changed importer -> gated.
    const graph = graphOf({ "src/ui/page.ts": ["src/db/client.ts"], "src/service/x.ts": [] });
    const all = findForbiddenEdges(graph, [RULE]);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ from: "src/ui/page.ts", to: "src/db/client.ts" });
    const gated = gatingViolations(all, new Set(["src/ui/page.ts"]));
    expect(gated).toHaveLength(1); // introduced/retained: importer is a changed file
  });

  it("does not flag an edge the change removed (absent from the post-change graph)", () => {
    // The change dropped the ui->db import; the post-change graph has no such edge.
    const graph = graphOf({ "src/ui/page.ts": ["src/service/x.ts"] });
    const all = findForbiddenEdges(graph, [RULE]);
    expect(all).toHaveLength(0);
    expect(gatingViolations(all, new Set(["src/ui/page.ts"]))).toHaveLength(0);
  });

  it("does not gate an unrelated pre-existing edge (importer not changed), but reports it repo-wide", () => {
    const graph = graphOf({ "src/ui/legacy.ts": ["src/db/client.ts"], "src/ui/page.ts": ["src/service/x.ts"] });
    const all = findForbiddenEdges(graph, [RULE]);
    expect(all).toHaveLength(1); // repo-wide: the legacy edge shows up
    // ...but the change only touched page.ts, so the legacy edge does not gate.
    expect(gatingViolations(all, new Set(["src/ui/page.ts"]))).toHaveLength(0);
  });

  it("returns nothing when no rules are configured", () => {
    expect(findForbiddenEdges(graphOf({ "src/ui/page.ts": ["src/db/client.ts"] }), [])).toEqual([]);
  });
});

describe("glob precision", () => {
  it("matches only when both from and to globs match", () => {
    const graph = graphOf({
      "src/ui/page.ts": ["src/db/client.ts", "src/util/fmt.ts"], // only the db edge violates
      "src/api/handler.ts": ["src/db/client.ts"], // from doesn't match src/ui/**
    });
    const v = findForbiddenEdges(graph, [RULE]);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ from: "src/ui/page.ts", to: "src/db/client.ts" });
  });

  it("distinguishes * (one segment) from ** (across segments)", () => {
    const graph = graphOf({ "src/ui/page.ts": ["src/db/x.ts"], "src/ui/deep/page.ts": ["src/db/x.ts"] });
    const single = findForbiddenEdges(graph, [{ from: "src/ui/*.ts", to: "src/db/**", reason: "r" }]);
    expect(single.map((v) => v.from)).toEqual(["src/ui/page.ts"]); // *.ts doesn't cross the deep/ segment
    const deep = findForbiddenEdges(graph, [{ from: "src/ui/**", to: "src/db/**", reason: "r" }]);
    expect(deep.map((v) => v.from).sort()).toEqual(["src/ui/deep/page.ts", "src/ui/page.ts"]);
  });

  it("describes a violation with the exact edge, rule, and reason", () => {
    const v = findForbiddenEdges(graphOf({ "src/ui/page.ts": ["src/db/client.ts"] }), [RULE])[0]!;
    const text = describeViolation(v);
    expect(text).toContain("src/ui/page.ts → src/db/client.ts");
    expect(text).toContain("service layer");
  });
});

describe("policy parsing of forbiddenImports", () => {
  const base = { version: 1 };

  it("parses valid rules", () => {
    const p = parsePolicy({ ...base, forbiddenImports: [{ from: "src/ui/**", to: "src/db/**", reason: "layering" }] });
    expect("error" in p).toBe(false);
    if ("error" in p) return;
    expect(p.forbiddenImports).toEqual([{ from: "src/ui/**", to: "src/db/**", reason: "layering" }]);
  });

  it("rejects a rule missing a field", () => {
    const p = parsePolicy({ ...base, forbiddenImports: [{ from: "src/ui/**", reason: "no to" }] });
    expect("error" in p && p.error).toMatch(/forbiddenImports/);
  });

  it("rejects a non-string / empty glob", () => {
    expect("error" in parsePolicy({ ...base, forbiddenImports: [{ from: "src/ui/**", to: 5, reason: "x" }] })).toBe(true);
    expect("error" in parsePolicy({ ...base, forbiddenImports: [{ from: "", to: "src/db/**", reason: "x" }] })).toBe(true);
  });

  it("rejects a non-array forbiddenImports", () => {
    expect("error" in parsePolicy({ ...base, forbiddenImports: "nope" })).toBe(true);
  });

  it("defaults to no rules when the key is absent", () => {
    const p = parsePolicy(base);
    expect("error" in p).toBe(false);
    if ("error" in p) return;
    expect(p.forbiddenImports).toEqual([]);
  });
});
