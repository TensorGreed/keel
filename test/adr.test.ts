import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteEventStore } from "../src/events/sqlite-store.js";
import type { KeelEvent } from "../src/events/store.js";
import type { FileGraph } from "../src/graph/dependencies.js";
import { parseAdr } from "../src/adr/parse.js";
import { ingestAdrs, linkAdr } from "../src/adr/ingest.js";
import { answerWhy, type WhyResult } from "../src/retrieval/why.js";
import { addHumanDecision } from "../src/mining/decision-cli.js";
import { rmDir } from "./helpers/platform.js";

// --- fixtures ---------------------------------------------------------------

const MADR = `# 1. Use PostgreSQL for the primary store

## Status

Accepted

## Context and Problem Statement

We need a relational database. See src/db/pg.ts and the schema in src/db/schema.sql.

## Decision Outcome

We will use PostgreSQL because of its JSONB support and maturity.
`;

const FRONTMATTER_ADR = `---
status: superseded
date: 2023-06-01
---
# Adopt event sourcing

## Context
Auditability matters.

## Decision
Persist events, derive state.
`;

const repos: string[] = [];
function tmpRepo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "keel-adr-"));
  repos.push(d);
  return d;
}
function writeAdr(root: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}
afterEach(() => {
  while (repos.length) rmDir(repos.pop()!);
});

async function adrEvents(store: SqliteEventStore): Promise<KeelEvent[]> {
  return (await store.byKind("decision", 100_000)).filter((d) => d.payload["origin"] === "adr");
}

function ok(r: WhyResult | { error: string }): WhyResult {
  if ("error" in r) throw new Error(r.error);
  return r;
}
function makeGraph(files: string[]): FileGraph {
  return { imports: new Map(), importedBy: new Map(), importSymbols: new Map(), exportsOf: new Map(), files };
}

// --- parsing ----------------------------------------------------------------

describe("adr: parse (MADR-style)", () => {
  it("extracts the title (number stripped), status, context, and decision", () => {
    const p = parseAdr(MADR);
    expect(p.title).toBe("Use PostgreSQL for the primary store");
    expect(p.status).toBe("Accepted");
    expect(p.context).toContain("relational database");
    expect(p.decision).toContain("JSONB");
  });

  it("reads status/date from YAML frontmatter and the title from the first heading", () => {
    const p = parseAdr(FRONTMATTER_ADR);
    expect(p.title).toBe("Adopt event sourcing");
    expect(p.status).toBe("superseded");
    expect(p.date).toBe("2023-06-01");
    expect(p.decision).toContain("Persist events");
  });

  it("falls back to the first non-empty line when there is no heading", () => {
    expect(parseAdr("Just a decision, no heading.\n").title).toBe("Just a decision, no heading.");
  });
});

// --- linkage ----------------------------------------------------------------

describe("adr: link to graph nodes", () => {
  it("links repo-relative paths that exist in the graph, ignoring others", () => {
    const graph = new Set(["src/db/pg.ts", "src/db/schema.sql"]);
    expect(linkAdr(MADR, graph)).toEqual(["src/db/pg.ts", "src/db/schema.sql"]);
    // A path not in the graph is not linked.
    expect(linkAdr("see src/nope/gone.ts", graph)).toEqual([]);
  });
});

// --- ingestion --------------------------------------------------------------

describe("adr: ingest into the decision index", () => {
  it("ingests an ADR as an origin=adr decision, linked to the code it mentions", async () => {
    const root = tmpRepo();
    writeAdr(root, "docs/adr/0001-use-postgres.md", MADR);
    const store = new SqliteEventStore(":memory:");
    try {
      const r = await ingestAdrs(store, root, new Set(["src/db/pg.ts", "src/db/schema.sql"]));
      expect(r).toMatchObject({ scanned: 1, ingested: 1, unchanged: 0, linked: 1 });

      const [adr] = await adrEvents(store);
      expect(adr!.externalId).toBe("adr:docs/adr/0001-use-postgres.md");
      expect(adr!.title).toBe("Use PostgreSQL for the primary store");
      expect(adr!.payload["status"]).toBe("Accepted");
      expect(adr!.payload["adrPath"]).toBe("docs/adr/0001-use-postgres.md");
      expect(adr!.files).toEqual(["src/db/pg.ts", "src/db/schema.sql"]);
    } finally {
      store.close();
    }
  });

  it("also scans docs/decisions and leaves an unlinked ADR with no files", async () => {
    const root = tmpRepo();
    writeAdr(root, "docs/decisions/adopt-es.md", FRONTMATTER_ADR);
    const store = new SqliteEventStore(":memory:");
    try {
      const r = await ingestAdrs(store, root, new Set(["src/unrelated.ts"]));
      expect(r).toMatchObject({ scanned: 1, ingested: 1, linked: 0 });
      expect((await adrEvents(store))[0]!.files).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("is idempotent by content hash: a re-run ingests nothing", async () => {
    const root = tmpRepo();
    writeAdr(root, "docs/adr/0001.md", MADR);
    const store = new SqliteEventStore(":memory:");
    try {
      await ingestAdrs(store, root, new Set());
      const second = await ingestAdrs(store, root, new Set());
      expect(second).toMatchObject({ scanned: 1, ingested: 0, unchanged: 1 });
      expect(await adrEvents(store)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("re-ingests an edited ADR, replacing the prior event (no duplicate)", async () => {
    const root = tmpRepo();
    writeAdr(root, "docs/adr/0001.md", MADR);
    const store = new SqliteEventStore(":memory:");
    try {
      await ingestAdrs(store, root, new Set());
      // edit: new title + content → new hash
      writeAdr(root, "docs/adr/0001.md", MADR.replace("Use PostgreSQL for the primary store", "Use SQLite instead"));
      const r = await ingestAdrs(store, root, new Set());
      expect(r).toMatchObject({ ingested: 1, unchanged: 0 });
      const events = await adrEvents(store);
      expect(events).toHaveLength(1); // replaced, not duplicated
      expect(events[0]!.title).toBe("Use SQLite instead");
    } finally {
      store.close();
    }
  });
});

// --- ranking among origins --------------------------------------------------

describe("adr: ranking among decision origins", () => {
  it("ranks ADRs above mined records but below an explicit `keel decision add`", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      // three decisions, all linked to a.ts, distinguishable by origin
      store.appendMany([
        {
          kind: "decision", externalId: "decision:o/r#5", occurredAt: "2021-01-01T00:00:00Z", title: "mined one",
          payload: { origin: "mined", summary: "mined one", rationale: "", alternatives: [], confidence: "high", prNumber: 5 },
          files: ["a.ts"],
        },
        {
          kind: "decision", externalId: "adr:docs/adr/0007.md", occurredAt: "2023-01-01T00:00:00Z", title: "the ADR",
          payload: { origin: "adr", summary: "the ADR", rationale: "", alternatives: [], confidence: "high", adrPath: "docs/adr/0007.md" },
          files: ["a.ts"],
        },
      ]);
      addHumanDecision(store, { summary: "pinned by a human", files: ["a.ts"] });

      const graph = makeGraph(["a.ts"]);
      const result = ok(await answerWhy(store, { path: "a.ts" }, { graph, embedModel: null, repoRef: { owner: "o", repo: "r" } }));
      expect(result.decisions.map((d) => d.origin)).toEqual(["human", "adr", "mined"]);

      // the ADR's receipt is its file path, not a PR
      const adr = result.decisions.find((d) => d.origin === "adr")!;
      expect(adr.source.adrPath).toBe("docs/adr/0007.md");
      expect(adr.source.url).toBe("docs/adr/0007.md");
      expect(adr.source.pr).toBeNull();
    } finally {
      store.close();
    }
  });

  it("surfaces an unlinked ADR through question (keyword) search", async () => {
    const store = new SqliteEventStore(":memory:");
    try {
      store.appendMany([
        {
          kind: "decision", externalId: "adr:docs/adr/0009.md", occurredAt: "2023-01-01T00:00:00Z", title: "Prefer gRPC over REST internally",
          payload: { origin: "adr", summary: "Prefer gRPC over REST internally", rationale: "lower latency", alternatives: [], confidence: "high", adrPath: "docs/adr/0009.md" },
        },
      ]);
      const result = ok(await answerWhy(store, { question: "why gRPC internally" }, { graph: null, embedModel: null, repoRef: null }));
      expect(result.decisions.map((d) => d.id)).toContain("adr:docs/adr/0009.md");
    } finally {
      store.close();
    }
  });
});
