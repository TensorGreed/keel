import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "../src/events/sqlite-store.js";
import type { KeelEvent } from "../src/events/store.js";
import type { FileGraph } from "../src/graph/dependencies.js";
import { EmbeddingError, type EmbeddingModel } from "../src/retrieval/embed.js";
import { answerWhy, type WhyResult } from "../src/retrieval/why.js";
import { addHumanDecision } from "../src/mining/decision-cli.js";
import { mineDecisions } from "../src/mining/mine.js";
import type { DecisionModel } from "../src/mining/model.js";

let seq = 0;
function minedDecision(pr: number, files: string[], extra: { summary?: string; rationale?: string; prUrl?: string | null } = {}): KeelEvent {
  return {
    kind: "decision",
    externalId: `decision:o/r#${pr}`,
    occurredAt: `2021-01-01T00:00:0${seq++}Z`,
    actor: "alice",
    title: extra.summary ?? `decision ${pr}`,
    payload: {
      origin: "mined",
      prNumber: pr,
      summary: extra.summary ?? `decision ${pr}`,
      rationale: extra.rationale ?? "",
      alternatives: [],
      confidence: "high",
      prUrl: "prUrl" in extra ? extra.prUrl : `https://github.com/o/r/pull/${pr}`,
    },
    files,
  };
}

function makeGraph(edges: Record<string, string[]>): FileGraph {
  const imports = new Map<string, Set<string>>();
  for (const [f, deps] of Object.entries(edges)) imports.set(f, new Set(deps));
  const importedBy = new Map<string, Set<string>>();
  for (const [f, deps] of imports) for (const d of deps) (importedBy.get(d) ?? importedBy.set(d, new Set()).get(d)!).add(f);
  const files = [...new Set([...imports.keys(), ...importedBy.keys()])];
  return { imports, importedBy, importSymbols: new Map(), exportsOf: new Map(), files };
}

class FakeEmbeddingModel implements EmbeddingModel {
  readonly name = "fake";
  constructor(private readonly vec: (t: string) => number[], private readonly fail?: string) {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (this.fail) throw new EmbeddingError(this.fail);
    return texts.map((t) => Float32Array.from(this.vec(t)));
  }
}

const REF = { owner: "o", repo: "r" };
function ok(r: WhyResult | { error: string }): WhyResult {
  if ("error" in r) throw new Error(r.error);
  return r;
}

// --- file linkage + receipts ------------------------------------------------

describe("why by path", () => {
  it("links direct/dependency/dependent decisions with source receipts", async () => {
    const graph = makeGraph({ "b.ts": ["a.ts"], "c.ts": ["b.ts"] });
    const store = new SqliteEventStore(":memory:");
    store.appendMany([minedDecision(1, ["a.ts"]), minedDecision(2, ["b.ts"]), minedDecision(3, ["c.ts"])]);

    const result = ok(await answerWhy(store, { path: "b.ts" }, { graph, embedModel: null, repoRef: REF }));
    expect(result.searched).toEqual({ byFile: true, semantic: false });
    const byReason = new Map(result.decisions.map((d) => [d.id, d.matchReason]));
    expect(byReason.get("decision:o/r#2")).toBe("direct");
    expect(byReason.get("decision:o/r#1")).toBe("dependency (a.ts)");
    expect(byReason.get("decision:o/r#3")).toBe("dependent (c.ts)");

    const direct = result.decisions.find((d) => d.id === "decision:o/r#2")!;
    expect(direct.source).toEqual({ pr: 2, url: "https://github.com/o/r/pull/2", author: "alice", date: expect.any(String) });
    store.close();
  });

  it("constructs a PR URL from the repo ref when the decision lacks one", async () => {
    const store = new SqliteEventStore(":memory:");
    store.appendMany([minedDecision(9, ["a.ts"], { prUrl: null })]);
    const result = ok(await answerWhy(store, { path: "a.ts" }, { graph: makeGraph({}), embedModel: null, repoRef: REF }));
    expect(result.decisions[0]!.source.url).toBe("https://github.com/o/r/pull/9");
    store.close();
  });

  it("still returns a decision with an unresolvable source, flagged in notes", async () => {
    const store = new SqliteEventStore(":memory:");
    store.appendMany([minedDecision(9, ["a.ts"], { prUrl: null })]);
    const result = ok(await answerWhy(store, { path: "a.ts" }, { graph: makeGraph({}), embedModel: null, repoRef: null }));
    expect(result.decisions[0]!.source.url).toBeNull();
    expect(result.notes.some((n) => /no resolvable PR link/i.test(n))).toBe(true);
    store.close();
  });
});

// --- question search + fallback ---------------------------------------------

describe("why by question", () => {
  it("ranks by semantic similarity when embeddings and a model are available", async () => {
    const store = new SqliteEventStore(":memory:");
    store.appendMany([minedDecision(1, ["db.ts"], { summary: "database" }), minedDecision(2, ["auth.ts"], { summary: "auth" })]);
    store.setEmbedding("decision", "decision:o/r#1", Float32Array.from([1, 0]));
    store.setEmbedding("decision", "decision:o/r#2", Float32Array.from([0, 1]));

    const model = new FakeEmbeddingModel(() => [0.9, 0.1]);
    const result = ok(await answerWhy(store, { question: "which db" }, { graph: null, embedModel: model, repoRef: REF }));
    expect(result.searched.semantic).toBe(true);
    expect(result.decisions[0]!.id).toBe("decision:o/r#1");
    expect(result.decisions[0]!.matchReason).toBe("semantic");
    store.close();
  });

  it("falls back to keyword match when nothing is embedded, with a note", async () => {
    const store = new SqliteEventStore(":memory:");
    store.appendMany([minedDecision(1, ["db.ts"], { summary: "picked SQLite for the database" }), minedDecision(2, ["auth.ts"], { summary: "token auth" })]);
    const result = ok(await answerWhy(store, { question: "database" }, { graph: null, embedModel: new FakeEmbeddingModel(() => [1]), repoRef: REF }));
    expect(result.searched.semantic).toBe(false);
    expect(result.decisions.map((d) => d.id)).toEqual(["decision:o/r#1"]);
    expect(result.decisions[0]!.matchReason).toBe("keyword");
    expect(result.notes.some((n) => /keyword/i.test(n))).toBe(true);
    store.close();
  });

  it("falls back to keyword when the local embedding model is unreachable", async () => {
    const store = new SqliteEventStore(":memory:");
    store.appendMany([minedDecision(1, ["db.ts"], { summary: "picked SQLite for the database" })]);
    store.setEmbedding("decision", "decision:o/r#1", Float32Array.from([1, 0]));
    const model = new FakeEmbeddingModel(() => [1, 0], "connection refused");
    const result = ok(await answerWhy(store, { question: "database" }, { graph: null, embedModel: model, repoRef: REF }));
    expect(result.searched.semantic).toBe(false);
    expect(result.decisions.map((d) => d.id)).toEqual(["decision:o/r#1"]);
    expect(result.notes.some((n) => /unreachable/i.test(n))).toBe(true);
    store.close();
  });
});

// --- honest emptiness -------------------------------------------------------

describe("why on an empty index", () => {
  it("points at ingest then mine when nothing is ingested", async () => {
    const store = new SqliteEventStore(":memory:");
    const result = ok(await answerWhy(store, { path: "a.ts" }, { graph: makeGraph({}), embedModel: null, repoRef: REF }));
    expect(result.decisions).toEqual([]);
    expect(result.notes.some((n) => /keel ingest/.test(n) && /keel mine/.test(n))).toBe(true);
    store.close();
  });

  it("points at mine when PRs are ingested but nothing is mined", async () => {
    const store = new SqliteEventStore(":memory:");
    store.appendMany([{ kind: "pr", externalId: "o/r#1", occurredAt: "2021-01-01T00:00:00Z", payload: { number: 1 } }]);
    const result = ok(await answerWhy(store, { question: "anything" }, { graph: null, embedModel: null, repoRef: REF }));
    expect(result.notes.some((n) => /1 PR/.test(n) && /keel mine/.test(n))).toBe(true);
    store.close();
  });
});

// --- human override (pin/correct) -------------------------------------------

describe("human decisions override mined ones", () => {
  it("ranks a human decision above a mined one for the same file", async () => {
    const store = new SqliteEventStore(":memory:");
    store.appendMany([minedDecision(1, ["a.ts"], { summary: "mined take" })]);
    addHumanDecision(store, { summary: "the real reason", files: ["a.ts"], author: "carol", date: "2021-02-01T00:00:00Z" });

    const result = ok(await answerWhy(store, { path: "a.ts" }, { graph: makeGraph({}), embedModel: null, repoRef: REF }));
    expect(result.decisions[0]!.origin).toBe("human");
    expect(result.decisions[0]!.summary).toBe("the real reason");
    expect(result.decisions[1]!.origin).toBe("mined");
    store.close();
  });

  it("surfaces a human decision by keyword for a question, even unembedded", async () => {
    const store = new SqliteEventStore(":memory:");
    addHumanDecision(store, { summary: "we chose eventual consistency", files: [], date: "2021-02-01T00:00:00Z" });
    const result = ok(await answerWhy(store, { question: "consistency" }, { graph: null, embedModel: null, repoRef: REF }));
    expect(result.decisions.map((d) => d.origin)).toEqual(["human"]);
    store.close();
  });

  it("excludes a rejected decision but keeps it in the log", async () => {
    const store = new SqliteEventStore(":memory:");
    store.appendMany([minedDecision(1, ["a.ts"]), minedDecision(2, ["a.ts"])]);
    store.suppressDecision("decision:o/r#1");

    const result = ok(await answerWhy(store, { path: "a.ts" }, { graph: makeGraph({}), embedModel: null, repoRef: REF }));
    expect(result.decisions.map((d) => d.id)).toEqual(["decision:o/r#2"]);
    expect(store.count("decision")).toBe(2); // still in the DB
    store.close();
  });
});

// --- reject survives re-mining ----------------------------------------------

class FakeDecisionModel implements DecisionModel {
  readonly name = "fake-miner";
  async complete(): Promise<string> {
    return JSON.stringify({ hasDecision: true, summary: "chose approach X", rationale: "because Y", alternatives: [], confidence: "high" });
  }
}

describe("rejection survives re-mining", () => {
  it("does not resurrect a suppressed decision when mine runs again", async () => {
    const store = new SqliteEventStore(":memory:");
    store.appendMany([
      { kind: "pr", externalId: "o/r#5", occurredAt: "2021-01-01T00:00:00Z", actor: "alice", title: "PR", payload: { number: 5, state: "closed", merged: true, url: "https://github.com/o/r/pull/5", reviews: [] }, files: ["a.ts"] },
    ]);
    const model = new FakeDecisionModel();

    const first = await mineDecisions(store, model);
    expect(first.mined).toBe(1);
    store.suppressDecision("decision:o/r#5");

    const second = await mineDecisions(store, model);
    expect(second.mined).toBe(0); // the PR is already mined; nothing re-created
    expect(store.count("decision")).toBe(1);

    const result = ok(await answerWhy(store, { path: "a.ts" }, { graph: makeGraph({}), embedModel: null, repoRef: REF }));
    expect(result.decisions).toEqual([]); // still suppressed
    store.close();
  });
});
