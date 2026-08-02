/**
 * Coverage gaps the fault-injection harness found, closed.
 *
 * `keel evidence` reports a trial as `undetected` when the full suite doesn't notice the injected
 * fault — a fact about the repo's coverage rather than about keel's selection. Those are not
 * failures, but they are findings, and three of them guarded behaviour worth guarding: the POST path
 * that publishes a GitHub check, the rule that stands between a user and a surprise API bill, and
 * the comparison that decides which link to a decision wins.
 *
 * Each test below exists because a mutation to the line it covers changed nothing observable. That
 * is the whole argument for the harness: it doesn't ask whether tests pass, it asks whether they
 * would notice.
 */
import { describe, expect, it } from "vitest";
import { FetchGitHubClient } from "../src/github/client.js";
import { estimateTokens, shouldWarnAboutCost } from "../src/mining/cli.js";
import { decisionsForFile } from "../src/retrieval/index.js";
import { SqliteEventStore } from "../src/events/sqlite-store.js";
import type { FileGraph } from "../src/graph/dependencies.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach } from "vitest";

describe("the GitHub client's POST body — the check-run publish path", () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    calls.length = 0;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends the body AND the JSON content type on a POST", async () => {
    // `if (body !== undefined)` guards both. Flipping it silently posts an empty, untyped request —
    // GitHub rejects that, and `keel verdict --github-check` would fail for a reason nothing here
    // would have explained.
    await new FetchGitHubClient(undefined, 5_000).post("/repos/o/r/check-runs", { name: "keel", status: "completed" });

    expect(calls).toHaveLength(1);
    const { init } = calls[0]!;
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ name: "keel", status: "completed" }));
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("sends no body and no content type on a GET", async () => {
    await new FetchGitHubClient(undefined, 5_000).get("/rate_limit");
    const { init } = calls[0]!;
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });
});

describe("the cost warning — what stands between a user and a surprise bill", () => {
  it("warns only for a paid backend, and only past the threshold", () => {
    expect(shouldWarnAboutCost(true, 26)).toBe(true);
    expect(shouldWarnAboutCost(true, 25)).toBe(false); // at the threshold, not past it
    expect(shouldWarnAboutCost(true, 0)).toBe(false);
  });

  it("never warns for a local model, however many PRs", () => {
    // Ollama costs nothing. Warning about it would train people to ignore the warning that matters.
    expect(shouldWarnAboutCost(false, 10_000)).toBe(false);
  });

  it("estimates tokens proportionally, so the number moves with the work", () => {
    expect(estimateTokens(100)).toBeGreaterThan(estimateTokens(50));
    expect(estimateTokens(0)).toBe(0);
  });
});

describe("which link to a decision wins", () => {
  let dir: string;
  let store: SqliteEventStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-links-"));
    store = new SqliteEventStore(path.join(dir, ".keel", "events.db"));
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("prefers the CLOSER link when one decision reaches a file two ways", async () => {
    // `isStrongerLink` compares distance first and only falls back to the reason's rank. Nothing
    // exercised the distance branch, so a decision could have been attributed via the further of
    // two paths — and `why` reports that path as its reason.
    const graph: FileGraph = {
      imports: new Map([
        ["a.ts", new Set(["b.ts"])],
        ["b.ts", new Set(["c.ts"])],
        ["c.ts", new Set<string>()],
      ]),
      importedBy: new Map([
        ["b.ts", new Set(["a.ts"])],
        ["c.ts", new Set(["b.ts"])],
        ["a.ts", new Set<string>()],
      ]),
      importSymbols: new Map(),
      exportsOf: new Map(),
      externalImports: new Map(),
      edgeKind: new Map(),
      files: ["a.ts", "b.ts", "c.ts"],
    };
    // One decision touching both the queried file's direct dependency and a further one.
    await store.append({
      kind: "decision",
      externalId: "decision:pr:1",
      occurredAt: "2026-01-01T00:00:00Z",
      title: "d",
      payload: { origin: "mined", summary: "d" },
      files: ["b.ts", "c.ts"],
    });

    const links = await decisionsForFile(store, graph, "a.ts");
    expect(links).toHaveLength(1); // deduped to one link per decision…
    expect(links[0]!.via).toBe("b.ts"); // …and it is the nearer of the two
  });
});
