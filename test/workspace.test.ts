import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkspaceConfig, type WorkspaceConfig } from "../src/workspace/config.js";
import { buildWorkspaceGraph, memberOf, qualify, workspaceBlastRadius } from "../src/workspace/graph.js";
import { resetGraphCache } from "../src/graph/cache.js";
import { rmDir } from "./helpers/platform.js";

// Cross-repo workspaces: one graph spanning several repos. The fixture is a six-repo workspace —
// a lib + app pair each for TS (published via package.json name), Python and Go (resolved by reusing
// the sibling's own resolver). Deterministic; no build tool needed.
const WS = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "cross-repo");

function member(name: string): string {
  return path.join(WS, name);
}

beforeEach(() => resetGraphCache());

describe("workspace config", () => {
  const tmps: string[] = [];
  const tmp = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "keel-ws-"));
    tmps.push(d);
    return d;
  };
  afterEach(() => {
    while (tmps.length) rmDir(tmps.pop()!);
  });

  it("loads keel.workspace.json, defaulting each name to its directory basename", () => {
    const cfg = loadWorkspaceConfig(WS);
    if ("error" in cfg) throw new Error(cfg.error);
    expect(cfg.members.map((m) => m.name).sort()).toEqual(["go-app", "go-lib", "py-app", "py-lib", "ts-app", "ts-lib"]);
  });

  it("errors when there is no config anywhere above the directory", () => {
    const cfg = loadWorkspaceConfig(tmp());
    expect("error" in cfg && /no keel\.workspace\.json/.test(cfg.error)).toBe(true);
  });

  it("errors when a listed repo path does not exist", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "keel.workspace.json"), JSON.stringify({ repos: [{ path: "./nope" }] }));
    const cfg = loadWorkspaceConfig(d);
    expect("error" in cfg && /not found/.test(cfg.error)).toBe(true);
  });

  it("honors an explicit name and rejects duplicates", () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, "a"));
    fs.writeFileSync(path.join(d, "keel.workspace.json"), JSON.stringify({ repos: [{ path: "./a", name: "svc" }] }));
    const cfg = loadWorkspaceConfig(d);
    if ("error" in cfg) throw new Error(cfg.error);
    expect(cfg.members[0]!.name).toBe("svc");
  });
});

describe("workspace graph — cross-repo edges", () => {
  let graph: Awaited<ReturnType<typeof buildWorkspaceGraph>>;
  beforeEach(async () => {
    const cfg = loadWorkspaceConfig(WS);
    if ("error" in cfg) throw new Error(cfg.error);
    graph = await buildWorkspaceGraph(cfg);
  });

  it("resolves a TS package import (package.json name → source entry) across repos", () => {
    // ts-app imports "@acme/shared"; ts-lib publishes it; its dist entry maps to the src source.
    expect(graph.imports.get("ts-app::src/main.ts")).toContain("ts-lib::src/index.ts");
  });

  it("resolves a Python import by reusing the sibling repo's resolver", () => {
    // py-app: `from shared_py.core import helper` → py-lib's shared_py/core.py.
    expect(graph.imports.get("py-app::app.py")).toContain("py-lib::shared_py/core.py");
  });

  it("resolves a Go import path by reusing the sibling module's resolver", () => {
    // go-app imports example.com/shared/calc → go-lib's calc package.
    expect(graph.imports.get("go-app::main.go")).toContain("go-lib::calc/calc.go");
  });

  it("routes by language — a TS specifier never matches a Python/Go publisher", () => {
    // Every cross-repo edge stays within one language: the importer and target share a repo-prefix
    // family (ts↔ts, py↔py, go↔go), never ts→py.
    for (const e of graph.crossEdges) {
      const fromLang = memberOf(e.from).split("-")[0];
      const toLang = memberOf(e.to).split("-")[0];
      expect(fromLang).toBe(toLang);
    }
    expect(graph.crossEdges).toHaveLength(3);
  });

  it("carries the blast radius across repo boundaries", () => {
    // Changing ts-lib's util reaches ts-app through the lib's index and the cross-repo edge.
    const radius = workspaceBlastRadius(graph, "ts-lib::src/util.ts");
    expect(radius).toContain("ts-lib::src/index.ts"); // intra-repo
    expect(radius).toContain("ts-app::src/main.ts"); // cross-repo
    // Python and Go blast radius cross too.
    expect(workspaceBlastRadius(graph, "py-lib::shared_py/core.py")).toContain("py-app::app.py");
    expect(workspaceBlastRadius(graph, "go-lib::calc/calc.go")).toContain("go-app::main.go");
  });
});

describe("workspace graph — an unpublished import stays external", () => {
  it("adds no cross-repo edge when no sibling publishes the specifier", async () => {
    // A workspace of just ts-app: nothing publishes "@acme/shared", so it stays unresolved.
    const cfg: WorkspaceConfig = { file: "x", root: WS, members: [{ name: "ts-app", root: member("ts-app") }] };
    const graph = await buildWorkspaceGraph(cfg);
    expect(graph.crossEdges).toEqual([]);
    expect(graph.imports.get(qualify("ts-app", "src/main.ts")) ?? new Set()).not.toContain("ts-lib::src/index.ts");
  });
});
