import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "../src/events/sqlite-store.js";
import type { KeelEvent } from "../src/events/store.js";
import type { FileGraph } from "../src/graph/dependencies.js";
import {
  cosineSimilarity,
  decisionText,
  embedDecisions,
  EmbeddingError,
  type EmbeddingModel,
} from "../src/retrieval/embed.js";
import { decisionsForFile, searchDecisions } from "../src/retrieval/index.js";

// --- helpers ----------------------------------------------------------------

let seq = 0;
function decision(id: string, files: string[], extra: { rationale?: string; alternatives?: string[] } = {}): KeelEvent {
  return {
    kind: "decision",
    externalId: `decision:${id}`,
    occurredAt: `2021-01-01T00:00:0${seq++}Z`,
    title: `summary ${id}`,
    payload: { summary: `summary ${id}`, rationale: extra.rationale ?? "", alternatives: extra.alternatives ?? [] },
    files,
  };
}

/** Build a FileGraph from `file -> [files it imports]` edges. */
function makeGraph(edges: Record<string, string[]>): FileGraph {
  const imports = new Map<string, Set<string>>();
  for (const [file, deps] of Object.entries(edges)) imports.set(file, new Set(deps));
  const importedBy = new Map<string, Set<string>>();
  for (const [file, deps] of imports) {
    for (const dep of deps) {
      const set = importedBy.get(dep) ?? new Set<string>();
      set.add(file);
      importedBy.set(dep, set);
    }
  }
  const files = [...new Set([...imports.keys(), ...importedBy.keys()])].sort();
  return { imports, importedBy, importSymbols: new Map(), exportsOf: new Map(), files };
}

class FakeEmbeddingModel implements EmbeddingModel {
  readonly name = "fake";
  constructor(
    private readonly vectorFor: (text: string) => number[],
    private readonly failWith?: string,
  ) {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (this.failWith) throw new EmbeddingError(this.failWith);
    return texts.map((t) => Float32Array.from(this.vectorFor(t)));
  }
}

// --- embedding storage + math -----------------------------------------------

describe("embedding storage", () => {
  it("round-trips a float32 vector keyed to an event", () => {
    const store = new SqliteEventStore(":memory:");
    store.appendMany([decision("a", ["a.ts"])]);
    const vec = Float32Array.from([0.1, -0.2, 0.3, 0.0]);
    store.setEmbedding("decision", "decision:a", vec);

    const all = store.embeddingsByKind("decision");
    expect([...all.keys()]).toEqual(["decision:a"]);
    expect(Array.from(all.get("decision:a")!)).toEqual(Array.from(vec));
    store.close();
  });

  it("ignores embeddings for events that don't exist", () => {
    const store = new SqliteEventStore(":memory:");
    store.setEmbedding("decision", "decision:missing", Float32Array.from([1, 2]));
    expect(store.embeddingsByKind("decision").size).toBe(0);
    store.close();
  });
});

describe("cosineSimilarity", () => {
  it("is 1 for identical, 0 for orthogonal, and handles zero vectors", () => {
    expect(cosineSimilarity(Float32Array.from([1, 2, 3]), Float32Array.from([2, 4, 6]))).toBeCloseTo(1);
    expect(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0);
    expect(cosineSimilarity(Float32Array.from([0, 0]), Float32Array.from([1, 1]))).toBe(0);
  });
});

describe("decisionText", () => {
  it("combines summary, rationale, and alternatives", () => {
    const d = decision("x", ["x.ts"], { rationale: "because reasons", alternatives: ["other"] });
    expect(decisionText(d)).toBe("summary x\nbecause reasons\nAlternatives: other");
  });
});

// --- embedDecisions ---------------------------------------------------------

describe("embedDecisions", () => {
  it("embeds pending decisions and is idempotent on re-run", async () => {
    const store = new SqliteEventStore(":memory:");
    store.appendMany([decision("a", ["a.ts"]), decision("b", ["b.ts"])]);
    const model = new FakeEmbeddingModel(() => [1, 0, 0]);

    const first = await embedDecisions(store, model);
    expect(first).toMatchObject({ total: 2, embedded: 2, skipped: 0 });
    expect(store.embeddingsByKind("decision").size).toBe(2);

    const second = await embedDecisions(store, model);
    expect(second).toMatchObject({ total: 2, embedded: 0, skipped: 2 });
    store.close();
  });

  it("surfaces a model failure as data without throwing", async () => {
    const store = new SqliteEventStore(":memory:");
    store.appendMany([decision("a", ["a.ts"])]);
    const result = await embedDecisions(store, new FakeEmbeddingModel(() => [1], "ollama unreachable"));
    expect(result.error).toBe("ollama unreachable");
    expect(result.embedded).toBe(0);
    expect(store.embeddingsByKind("decision").size).toBe(0);
    store.close();
  });
});

// --- decisionsForFile (graph linkage) ---------------------------------------

describe("decisionsForFile", () => {
  it("links direct, dependency, and dependent decisions, deduped to the strongest", async () => {
    // c.ts -> b.ts -> a.ts (imports).
    const graph = makeGraph({ "b.ts": ["a.ts"], "c.ts": ["b.ts"] });
    const store = new SqliteEventStore(":memory:");
    store.appendMany([
      decision("A", ["a.ts"]),
      decision("B", ["b.ts"]),
      decision("C", ["c.ts"]),
      decision("AB", ["a.ts", "b.ts"]), // linked to b directly AND to a as a dependency
    ]);

    const linked = await decisionsForFile(store, graph, "b.ts");
    const byId = new Map(linked.map((l) => [l.decision.externalId, l]));

    // b's own decisions are direct.
    expect(byId.get("decision:B")).toMatchObject({ reason: "direct", via: "b.ts", distance: 0 });
    // AB touches b directly — direct wins over the dependency link via a.ts.
    expect(byId.get("decision:AB")).toMatchObject({ reason: "direct", via: "b.ts", distance: 0 });
    // a.ts is a dependency of b; c.ts is a dependent.
    expect(byId.get("decision:A")).toMatchObject({ reason: "dependency", via: "a.ts", distance: 1 });
    expect(byId.get("decision:C")).toMatchObject({ reason: "dependent", via: "c.ts", distance: 1 });

    // Direct decisions sort ahead of neighbors.
    expect(linked.slice(0, 2).map((l) => l.reason)).toEqual(["direct", "direct"]);
    store.close();
  });

  it("returns nothing for a file with no linked decisions", async () => {
    const graph = makeGraph({ "b.ts": ["a.ts"] });
    const store = new SqliteEventStore(":memory:");
    store.appendMany([decision("Z", ["unrelated.ts"])]);
    expect(await decisionsForFile(store, graph, "a.ts")).toEqual([]);
    store.close();
  });
});

// --- searchDecisions (semantic) ---------------------------------------------

describe("searchDecisions", () => {
  it("ranks decisions by cosine similarity to the query", async () => {
    const store = new SqliteEventStore(":memory:");
    store.appendMany([
      decision("db", ["db.ts"]),
      decision("auth", ["auth.ts"]),
      decision("ui", ["ui.ts"]),
    ]);
    // Orthogonal decision vectors; the query aligns with "db".
    store.setEmbedding("decision", "decision:db", Float32Array.from([1, 0, 0]));
    store.setEmbedding("decision", "decision:auth", Float32Array.from([0, 1, 0]));
    store.setEmbedding("decision", "decision:ui", Float32Array.from([0, 0, 1]));

    const model = new FakeEmbeddingModel(() => [0.9, 0.1, 0]); // close to db
    const results = await searchDecisions(store, model, "which database did we pick?", 2);

    expect(results.map((r) => r.decision.externalId)).toEqual(["decision:db", "decision:auth"]);
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
    store.close();
  });

  it("returns nothing when no decisions are embedded", async () => {
    const store = new SqliteEventStore(":memory:");
    store.appendMany([decision("a", ["a.ts"])]);
    expect(await searchDecisions(store, new FakeEmbeddingModel(() => [1, 0, 0]), "anything")).toEqual([]);
    store.close();
  });
});
