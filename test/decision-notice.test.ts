import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerTools } from "../src/mcp/tools.js";
import { SqliteEventStore } from "../src/events/sqlite-store.js";
import type { KeelEvent } from "../src/events/store.js";
import { resetGraphCache } from "../src/graph/cache.js";

// get_dependencies / get_impact append a "call why" notice when their result files carry recorded
// decisions — so memory surfaces even when the agent read the code and never asked. Mock server.

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
function mockServer(): { tools: Map<string, Handler>; tool: (n: string, d: string, s: unknown, h: Handler) => void } {
  const tools = new Map<string, Handler>();
  return { tools, tool: (name, _d, _s, handler) => tools.set(name, handler) };
}
async function call(h: Handler, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return JSON.parse((await h(args)).content[0]!.text) as Record<string, unknown>;
}
function write(dir: string, rel: string, contents: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), contents);
}
function decision(externalId: string, files: string[]): KeelEvent {
  return {
    kind: "decision",
    externalId,
    occurredAt: "2021-01-01T00:00:00Z",
    title: "Use a fixed nonce derivation, not a hardcoded IV",
    payload: { origin: "human", summary: "Derive the IV per message", rationale: "reuse is a vuln", alternatives: [], confidence: "high" },
    files,
  };
}

let dir: string;
beforeEach(() => {
  resetGraphCache();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-notice-"));
  write(dir, "src/crypto.ts", "export function iv(): number { return 1; }\n");
  write(dir, "src/service.ts", 'import { iv } from "./crypto.js";\nexport const use = iv();\n');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("get_dependencies decision notice", () => {
  it("appends a 'call why' notice when a dependency carries a recorded decision", async () => {
    const store = new SqliteEventStore(":memory:");
    store.appendMany([decision("decision:238", ["src/crypto.ts"])]);
    const server = mockServer();
    registerTools(server as never, dir, store);

    // service imports crypto, which has a decision → the notice should surface.
    const out = await call(server.tools.get("get_dependencies")!, { file: "src/service.ts" });
    expect(String(out["decisionsNotice"])).toMatch(/^1 recorded decision\(s\) touch these files — call `why`/);
    store.close();
  });

  it("omits the notice when no result file has a decision", async () => {
    const store = new SqliteEventStore(":memory:");
    store.appendMany([decision("decision:999", ["src/unrelated.ts"])]);
    const server = mockServer();
    registerTools(server as never, dir, store);

    const out = await call(server.tools.get("get_dependencies")!, { file: "src/service.ts" });
    expect(out["decisionsNotice"]).toBeUndefined();
    store.close();
  });

  it("excludes suppressed (rejected) decisions from the count", async () => {
    const store = new SqliteEventStore(":memory:");
    store.appendMany([decision("decision:238", ["src/crypto.ts"])]);
    store.suppressDecision("decision:238");
    const server = mockServer();
    registerTools(server as never, dir, store);

    const out = await call(server.tools.get("get_dependencies")!, { file: "src/service.ts" });
    expect(out["decisionsNotice"]).toBeUndefined();
    store.close();
  });

  it("works (and stays silent) when the server has no event store", async () => {
    const server = mockServer();
    registerTools(server as never, dir); // no store
    const out = await call(server.tools.get("get_dependencies")!, { file: "src/service.ts" });
    expect(out["dependencies"]).toEqual(["src/crypto.ts"]);
    expect(out["decisionsNotice"]).toBeUndefined();
  });
});

describe("get_impact decision notice", () => {
  it("appends the notice when a changed/impacted file carries a decision", async () => {
    const store = new SqliteEventStore(":memory:");
    store.appendMany([decision("decision:258", ["src/crypto.ts"])]);
    const server = mockServer();
    registerTools(server as never, dir, store);

    const diff = [
      "diff --git a/src/crypto.ts b/src/crypto.ts",
      "--- a/src/crypto.ts",
      "+++ b/src/crypto.ts",
      "@@ -1 +1 @@",
      "-export function iv(): number { return 1; }",
      "+export function iv(): number { return 0; }",
      "",
    ].join("\n");
    const out = await call(server.tools.get("get_impact")!, { diff });
    expect(String(out["decisionsNotice"])).toMatch(/recorded decision\(s\) touch these files/);
    store.close();
  });
});
