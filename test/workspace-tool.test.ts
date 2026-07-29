import { beforeEach, describe, expect, it } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { registerTools } from "../src/mcp/tools.js";
import { resetGraphCache } from "../src/graph/cache.js";

// The workspace_impact MCP tool. It's a thin wrapper over the (separately tested) workspace graph,
// so here we assert its registration guard and its output shape via a minimal mock server.
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const CROSS_REPO = path.join(FIXTURES, "cross-repo");

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

function mockServer(): { tools: Map<string, Handler>; tool: (n: string, d: string, s: unknown, h: Handler) => void } {
  const tools = new Map<string, Handler>();
  return { tools, tool: (name, _desc, _schema, handler) => tools.set(name, handler) };
}

async function call(handler: Handler, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await handler(args);
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
}

beforeEach(() => resetGraphCache());

describe("workspace_impact registration guard", () => {
  it("is registered when this repo is inside a workspace", () => {
    const server = mockServer();
    registerTools(server as never, path.join(CROSS_REPO, "ts-lib"));
    expect(server.tools.has("workspace_impact")).toBe(true);
  });

  it("is NOT registered for a repo with no workspace config above it", () => {
    const server = mockServer();
    // the plain single-module Maven fixture has no keel.workspace.json anywhere above it
    registerTools(server as never, path.join(FIXTURES, "java-maven"));
    expect(server.tools.has("workspace_impact")).toBe(false);
    expect(server.tools.has("get_dependencies")).toBe(true); // ordinary tools still register
  });
});

describe("workspace_impact output", () => {
  it("returns the cross-repo blast radius (grouped) and the matching edges for a bare path", async () => {
    const server = mockServer();
    registerTools(server as never, path.join(CROSS_REPO, "ts-lib"));
    const out = await call(server.tools.get("workspace_impact")!, { file: "src/util.ts" });

    expect(out["file"]).toBe("ts-lib::src/util.ts"); // a bare path is qualified to the current repo
    expect(out["repo"]).toBe("ts-lib");
    expect(out["blastRadius"]).toBe(2);
    expect(out["crossRepoDependents"]).toBe(1);
    expect(out["byRepo"]).toEqual({
      "ts-app": ["ts-app::src/main.ts"], // the consumer in another repo
      "ts-lib": ["ts-lib::src/index.ts"], // intra-repo
    });
    expect(out["crossEdges"]).toEqual([
      { from: "ts-app::src/main.ts", to: "ts-lib::src/index.ts", specifier: "@acme/shared" },
    ]);
  });

  it("accepts an already-qualified <repo>::<path> file", async () => {
    const server = mockServer();
    registerTools(server as never, path.join(CROSS_REPO, "ts-app"));
    const out = await call(server.tools.get("workspace_impact")!, { file: "py-lib::shared_py/core.py" });
    expect(out["blastRadius"]).toBe(1);
    expect(out["byRepo"]).toEqual({ "py-app": ["py-app::app.py"] });
  });

  it("errors clearly for a path that is not a workspace file", async () => {
    const server = mockServer();
    registerTools(server as never, path.join(CROSS_REPO, "ts-lib"));
    const out = await call(server.tools.get("workspace_impact")!, { file: "src/nope.ts" });
    expect(String(out["error"])).toMatch(/not a workspace file/);
  });
});
