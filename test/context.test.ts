import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "../src/events/sqlite-store.js";
import type { KeelEvent } from "../src/events/store.js";
import type { FileGraph } from "../src/graph/dependencies.js";
import type { CommitInfo } from "../src/git/history.js";
import { DEFAULT_POLICY, type Policy } from "../src/trust/policy.js";
import { buildContext, type Briefing, type ContextDeps } from "../src/context/briefing.js";

// buildContext composes graph + git + decisions + policy with NO model calls (embedModel null
// here forces the keyword path). All I/O is injected, so this runs without git or Ollama.

/** Graph from an import map, with optional per-file exports for keyword matching. */
function makeGraph(edges: Record<string, string[]>, exportsOf: Record<string, string[]> = {}): FileGraph {
  const imports = new Map<string, Set<string>>();
  for (const [f, deps] of Object.entries(edges)) imports.set(f, new Set(deps));
  const importedBy = new Map<string, Set<string>>();
  for (const [f, deps] of imports) for (const d of deps) (importedBy.get(d) ?? importedBy.set(d, new Set()).get(d)!).add(f);
  const files = [...new Set([...imports.keys(), ...[...importedBy.keys()]])];
  // Every scanned file is a key in `imports` in a real graph (empty set if it imports nothing).
  for (const f of files) if (!imports.has(f)) imports.set(f, new Set());
  return {
    imports,
    importedBy,
    importSymbols: new Map(),
    exportsOf: new Map(Object.entries(exportsOf).map(([f, e]) => [f, new Set(e)])),
    files,
  };
}

let seq = 0;
function decision(id: string, files: string[], summary: string, origin: "mined" | "human" = "mined"): KeelEvent {
  return {
    kind: "decision",
    externalId: id,
    occurredAt: `2021-01-01T00:00:0${seq++}Z`,
    actor: "alice",
    title: summary,
    payload: { origin, summary, rationale: "", alternatives: [], confidence: "high", prNumber: 7 },
    files,
  };
}

const commit: CommitInfo = { hash: "abcdef1234567", author: "alice", email: "a@e.com", date: "2021-02-01T00:00:00Z", subject: "add login", body: "" };

// A graph where big.ts has a large blast radius, util.ts is uncovered, auth.ts is protected.
function fixture(): { graph: FileGraph; deps: (over?: Partial<ContextDeps>) => ContextDeps; store: SqliteEventStore } {
  const bigDeps: Record<string, string[]> = { "src/big.test.ts": ["src/big.ts"] };
  for (let i = 0; i < 30; i++) bigDeps[`src/d${i}.ts`] = ["src/big.ts"];
  const graph = makeGraph(
    {
      "src/auth.test.ts": ["src/auth.ts"],
      "src/session.ts": ["src/auth.ts"],
      "src/session.test.ts": ["src/session.ts"],
      "src/util.ts": [], // a leaf: in the graph, imported by nothing -> uncovered
      ...bigDeps,
    },
    { "src/auth.ts": ["login", "logout"], "src/util.ts": ["formatDate"], "src/big.ts": ["core"] },
  );

  const store = new SqliteEventStore(":memory:");
  const policy: Policy = {
    ...DEFAULT_POLICY,
    maxBlastRadius: 25,
    protectedPaths: [{ glob: "src/auth.ts", reason: "security-critical" }],
  };

  const deps = (over: Partial<ContextDeps> = {}): ContextDeps => ({
    graph,
    store,
    embedModel: null,
    repoRef: { owner: "o", repo: "r" },
    policy,
    history: async (f) => (f === "src/auth.ts" ? [commit] : []),
    ...over,
  });
  return { graph, deps, store };
}

function ok(b: Briefing | { error: string }): Briefing {
  if ("error" in b) throw new Error(b.error);
  return b;
}

describe("buildContext", () => {
  it("errors on an empty task", async () => {
    const { deps } = fixture();
    expect("error" in (await buildContext({ task: "  " }, deps()))).toBe(true);
  });

  it("resolves candidates from keyword match on paths and exports", async () => {
    const { deps } = fixture();
    const b = ok(await buildContext({ task: "add rate limiting to login" }, deps()));
    const files = b.candidates.map((c) => c.file);
    expect(files).toContain("src/auth.ts"); // matched by its `login` export
    const auth = b.candidates.find((c) => c.file === "src/auth.ts")!;
    expect(auth.why).toMatch(/path\/export/);
    expect(auth.blastRadius).toBe(3); // auth.test.ts + session.ts + session.test.ts
  });

  it("briefs blast radius, key dependents, tests, and history per candidate", async () => {
    const { deps } = fixture();
    const b = ok(await buildContext({ task: "login change", files: ["src/auth.ts"] }, deps()));
    const auth = b.candidates.find((c) => c.file === "src/auth.ts")!;
    expect(auth.tests.covering).toEqual(["src/auth.test.ts", "src/session.test.ts"]);
    expect(auth.tests.uncovered).toBe(false);
    expect(auth.keyDependents).toContain("src/session.ts");
    expect(auth.recentHistory[0]?.subject).toBe("add login");
    expect(auth.recentHistory[0]?.hash).toBe("abcdef123"); // shortened to 9
  });

  it("flags uncovered, high-blast-radius, and protected-path risks", async () => {
    const { deps } = fixture();
    const b = ok(await buildContext({ task: "touch things", files: ["src/auth.ts", "src/util.ts", "src/big.ts"] }, deps()));
    const byType = (t: string) => b.risks.filter((r) => r.type === t).map((r) => r.file);
    expect(byType("protected-path")).toContain("src/auth.ts");
    expect(byType("uncovered")).toContain("src/util.ts");
    expect(byType("high-blast-radius")).toContain("src/big.ts"); // 31 dependents ≥ 25
  });

  it("links decisions with receipts and rolls them up human-first", async () => {
    const { deps, store } = fixture();
    store.appendMany([
      decision("d:mined", ["src/auth.ts"], "auth uses JWT", "mined"),
      decision("d:human", ["src/util.ts"], "keep util pure", "human"),
    ]);
    const b = ok(await buildContext({ task: "login work", files: ["src/auth.ts", "src/util.ts"] }, deps()));
    const auth = b.candidates.find((c) => c.file === "src/auth.ts")!;
    expect(auth.decisions.map((d) => d.id)).toContain("d:mined");
    expect(auth.decisions[0]?.source.url).toBe("https://github.com/o/r/pull/7");
    expect(b.relevantDecisions[0]?.origin).toBe("human"); // human outranks mined in the rollup
  });

  it("surfaces files behind task-relevant decisions (keyword)", async () => {
    const { deps, store } = fixture();
    store.append(decision("d:sess", ["src/session.ts"], "throttle login attempts", "mined"));
    const b = ok(await buildContext({ task: "add login throttle" }, deps()));
    const sess = b.candidates.find((c) => c.file === "src/session.ts");
    expect(sess?.why).toMatch(/linked to decision/);
  });

  it("caps candidates at topN and notes what was omitted", async () => {
    const { deps } = fixture();
    const b = ok(await buildContext({ task: "many", topN: 2, files: ["src/d0.ts", "src/d1.ts", "src/d2.ts"] }, deps()));
    expect(b.candidates.length).toBe(2);
    expect(b.notes.some((n) => /briefing the top 2/.test(n))).toBe(true);
  });

  it("ignores provided paths not in the graph, with a note", async () => {
    const { deps } = fixture();
    const b = ok(await buildContext({ task: "x", files: ["does/not/exist.ts"] }, deps()));
    expect(b.notes.some((n) => /not in the graph/.test(n))).toBe(true);
  });

  it("notes keyword-only ranking when no embedding model is configured", async () => {
    const { deps } = fixture();
    const b = ok(await buildContext({ task: "login", files: ["src/auth.ts"] }, deps()));
    expect(b.notes.some((n) => /keyword/i.test(n))).toBe(true);
  });
});
