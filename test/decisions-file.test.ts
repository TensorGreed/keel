/**
 * `.keel-decisions.jsonl` — decisions as code.
 *
 * What this has to be true for the feature to be worth anything: one person mines, commits the
 * file, and every clone thereafter has the memory. That makes three properties load-bearing, and
 * each is tested for its own reason rather than for coverage:
 *
 *   - **Byte-identical export from the same database.** If two machines exporting the same index
 *     produce different bytes, every commit churns the file and the team stops reading its diff —
 *     at which point a committed export is worse than no export.
 *   - **Import fills gaps, never overwrites.** The file arrives from other people. A local human
 *     record — the strongest signal keel has — must survive contact with it.
 *   - **Suppression travels.** A decision the team rejected coming back to life on a teammate's
 *     clone is the one failure nobody would forgive, so it is asserted end to end.
 *
 * Plus the boring-but-fatal one: a hand-edited file with a bad line must cost that line, not the
 * command.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteEventStore } from "../src/events/sqlite-store.js";
import { addHumanDecision } from "../src/mining/decision-cli.js";
import {
  DECISIONS_FILE,
  exportDecisions,
  importDecisions,
  parseDecisions,
  serializeDecisions,
  toEvent,
  toRecord,
} from "../src/retrieval/decisions-file.js";
import { answerWhy } from "../src/retrieval/why.js";
import type { FileGraph } from "../src/graph/dependencies.js";
import { rmDir } from "./helpers/platform.js";

/** The minimum `answerWhy` needs to link decisions to a file: the file existing in a graph. */
function graphWith(...files: string[]): FileGraph {
  return {
    imports: new Map(files.map((f) => [f, new Set<string>()])),
    importedBy: new Map(files.map((f) => [f, new Set<string>()])),
    importSymbols: new Map(),
    exportsOf: new Map(),
    externalImports: new Map(),
    edgeKind: new Map(),
    files,
  };
}

let dir: string;
let store: SqliteEventStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-decisions-"));
  store = new SqliteEventStore(path.join(dir, ".keel", "events.db"));
});
afterEach(() => {
  store.close();
  rmDir(dir);
});

/** A mined decision, the shape `keel mine` writes. */
async function addMined(id: string, summary: string, files: string[] = [], pr = 42): Promise<void> {
  await store.append({
    kind: "decision",
    externalId: id,
    occurredAt: "2026-01-01T00:00:00Z",
    actor: "bot",
    title: summary,
    payload: { origin: "mined", summary, rationale: "because", alternatives: ["do nothing"], confidence: "medium", prNumber: pr },
    files,
  });
}

const read = (): string => fs.readFileSync(path.join(dir, DECISIONS_FILE), "utf8");

describe("export determinism", () => {
  it("produces byte-identical output from the same database, twice", async () => {
    await addMined("decision:pr:2", "Second", ["b.ts"]);
    await addMined("decision:pr:1", "First", ["a.ts"]);

    const first = await exportDecisions(store, dir);
    const bytes = read();
    expect(first.records).toBe(2);
    expect(first.changed).toBe(true);

    const second = await exportDecisions(store, dir);
    expect(read()).toBe(bytes);
    // Nothing changed, so the file isn't rewritten — git must not report a modification that isn't one.
    expect(second.changed).toBe(false);
  });

  it("sorts by id and puts one record on one line, so a new decision is a one-line diff", async () => {
    await addMined("decision:pr:9", "Nine");
    await addMined("decision:pr:1", "One");
    await exportDecisions(store, dir);

    const lines = read().trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => (JSON.parse(l) as { external_id: string }).external_id)).toEqual(["decision:pr:1", "decision:pr:9"]);
  });

  it("sorts the file list (a set) but never the alternatives (an ordered argument)", () => {
    const record = toRecord(
      {
        kind: "decision",
        externalId: "d1",
        occurredAt: "2026-01-01T00:00:00Z",
        payload: { origin: "mined", summary: "s", alternatives: ["z-first", "a-second"] },
        files: ["z.ts", "a.ts"],
      },
      false,
    );
    expect(record.files).toEqual(["a.ts", "z.ts"]);
    expect(record.alternatives).toEqual(["z-first", "a-second"]);
  });

  it("round-trips a record through the file and back to an event", () => {
    const original = {
      kind: "decision" as const,
      externalId: "decision:pr:7",
      occurredAt: "2026-03-04T05:06:07Z",
      actor: "alice",
      title: "Use Redis",
      payload: { origin: "mined", summary: "Use Redis", rationale: "faster", alternatives: ["Postgres"], confidence: "high", prNumber: 7, prUrl: "https://example.invalid/pr/7" },
      files: ["src/session.ts"],
    };
    const back = toEvent(toRecord(original, false));
    expect(back.externalId).toBe(original.externalId);
    expect(back.occurredAt).toBe(original.occurredAt);
    expect(back.actor).toBe("alice");
    expect(back.files).toEqual(["src/session.ts"]);
    expect(back.payload["prNumber"]).toBe(7);
    expect(back.payload["prUrl"]).toBe("https://example.invalid/pr/7");
    expect(back.payload["alternatives"]).toEqual(["Postgres"]);
  });

  it("writes an empty file for an empty index rather than a stray newline", () => {
    expect(serializeDecisions([])).toBe("");
  });
});

describe("import into a fresh clone", () => {
  it("loads every record into an empty index — memory with no mining", async () => {
    await addMined("decision:pr:1", "Session storage is Redis", ["src/session.ts"]);
    await addMined("decision:pr:2", "Retry with jitter", ["src/http.ts"]);
    await exportDecisions(store, dir);

    // A fresh clone: the committed file, and nothing else.
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), "keel-clone-"));
    fs.copyFileSync(path.join(dir, DECISIONS_FILE), path.join(clone, DECISIONS_FILE));
    const cloneStore = new SqliteEventStore(path.join(clone, ".keel", "events.db"));
    try {
      const result = await importDecisions(cloneStore, clone);
      expect(result.present).toBe(true);
      expect(result.imported).toBe(2);
      expect(result.warnings).toEqual([]);

      // And it is real memory: `why` answers from it immediately.
      const why = await answerWhy(cloneStore, { path: "src/session.ts" }, { graph: graphWith("src/session.ts"), embedModel: null, repoRef: null });
      if ("error" in why) throw new Error(why.error);
      expect(why.decisions.map((d) => d.summary)).toContain("Session storage is Redis");
    } finally {
      cloneStore.close();
      rmDir(clone);
    }
  });

  it("is idempotent, and skips the work entirely when the file hasn't changed", async () => {
    await addMined("decision:pr:1", "One");
    await exportDecisions(store, dir);

    const clone = fs.mkdtempSync(path.join(os.tmpdir(), "keel-clone-"));
    fs.copyFileSync(path.join(dir, DECISIONS_FILE), path.join(clone, DECISIONS_FILE));
    const cloneStore = new SqliteEventStore(path.join(clone, ".keel", "events.db"));
    try {
      expect((await importDecisions(cloneStore, clone)).imported).toBe(1);
      // Second call: the stamp matches, so it returns without reading or inserting anything.
      const again = await importDecisions(cloneStore, clone);
      expect(again.imported).toBe(0);
      expect(again.skipped).toBe(0);
      // Forced, it reads the file and finds everything already there.
      const forced = await importDecisions(cloneStore, clone, { force: true });
      expect(forced.imported).toBe(0);
      expect(forced.skipped).toBe(1);
      expect(await cloneStore.byKind("decision", 100)).toHaveLength(1);
    } finally {
      cloneStore.close();
      rmDir(clone);
    }
  });

  it("does nothing at all when the repo has no export file", async () => {
    const result = await importDecisions(store, dir);
    expect(result).toEqual({ imported: 0, suppressed: 0, skipped: 0, warnings: [], present: false });
  });
});

describe("conflict rule", () => {
  it("never overwrites a local record — a human pin survives contact with the file", async () => {
    // Same id in the file, different (worse) content. The local record must win.
    const id = addHumanDecision(store, { summary: "Locally pinned truth", files: ["a.ts"], rationale: "measured", date: "2026-05-05T00:00:00Z" });
    const file = [
      JSON.stringify({
        external_id: id,
        origin: "mined",
        summary: "A stale guess from someone else's machine",
        rationale: "",
        alternatives: [],
        confidence: "low",
        files: [],
        source: { pr: 1, url: null, adr: null, author: "bot", date: "2020-01-01T00:00:00Z" },
        suppressed: false,
      }),
    ].join("\n");
    fs.writeFileSync(path.join(dir, DECISIONS_FILE), `${file}\n`);

    const result = await importDecisions(store, dir, { force: true });
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);

    const [kept] = await store.byKind("decision", 10);
    expect(kept!.payload["summary"]).toBe("Locally pinned truth");
    expect(kept!.payload["origin"]).toBe("human");
  });

  it("fills gaps around a local record rather than replacing the set", async () => {
    addHumanDecision(store, { summary: "Mine", files: ["a.ts"], date: "2026-05-05T00:00:00Z" });
    fs.writeFileSync(
      path.join(dir, DECISIONS_FILE),
      `${JSON.stringify({
        external_id: "decision:pr:99",
        origin: "mined",
        summary: "Theirs",
        rationale: "",
        alternatives: [],
        confidence: "low",
        files: [],
        source: { pr: 99, url: null, adr: null, author: null, date: "2026-01-01T00:00:00Z" },
        suppressed: false,
      })}\n`,
    );

    await importDecisions(store, dir, { force: true });
    const summaries = (await store.byKind("decision", 10)).map((d) => d.payload["summary"]);
    expect(summaries).toContain("Mine");
    expect(summaries).toContain("Theirs");
  });
});

describe("suppression travels", () => {
  it("round-trips a rejection: exported as suppressed, and suppressed again on import", async () => {
    await addMined("decision:pr:1", "Keep this", ["a.ts"]);
    await addMined("decision:pr:2", "Rejected guess", ["a.ts"]);
    store.suppressDecision("decision:pr:2");
    await exportDecisions(store, dir);

    const records = parseDecisions(read()).records;
    expect(records.find((r) => r.external_id === "decision:pr:2")!.suppressed).toBe(true);
    expect(records.find((r) => r.external_id === "decision:pr:1")!.suppressed).toBe(false);

    const clone = fs.mkdtempSync(path.join(os.tmpdir(), "keel-clone-"));
    fs.copyFileSync(path.join(dir, DECISIONS_FILE), path.join(clone, DECISIONS_FILE));
    const cloneStore = new SqliteEventStore(path.join(clone, ".keel", "events.db"));
    try {
      const result = await importDecisions(cloneStore, clone);
      expect(result.imported).toBe(2);
      expect(result.suppressed).toBe(1);

      // The rejected one is in the log (auditable) but never returned.
      const why = await answerWhy(cloneStore, { path: "a.ts" }, { graph: graphWith("a.ts"), embedModel: null, repoRef: null });
      if ("error" in why) throw new Error(why.error);
      expect(why.decisions.map((d) => d.summary)).toEqual(["Keep this"]);
    } finally {
      cloneStore.close();
      rmDir(clone);
    }
  });

  it("suppresses a record the local index already had — the rejection is absolute", async () => {
    await addMined("decision:pr:1", "Locally present");
    fs.writeFileSync(
      path.join(dir, DECISIONS_FILE),
      `${JSON.stringify({
        external_id: "decision:pr:1",
        origin: "mined",
        summary: "Locally present",
        rationale: "",
        alternatives: [],
        confidence: "low",
        files: [],
        source: { pr: 1, url: null, adr: null, author: null, date: "2026-01-01T00:00:00Z" },
        suppressed: true,
      })}\n`,
    );

    const result = await importDecisions(store, dir, { force: true });
    expect(result.imported).toBe(0); // already there
    expect(result.suppressed).toBe(1); // …and now suppressed anyway
    expect(store.suppressedDecisions().has("decision:pr:1")).toBe(true);
  });
});

describe("a hand-edited file", () => {
  it("skips a malformed line with a warning and keeps the rest", async () => {
    const good = JSON.stringify({
      external_id: "decision:pr:1",
      origin: "mined",
      summary: "Survives",
      rationale: "",
      alternatives: [],
      confidence: "low",
      files: [],
      source: { pr: 1, url: null, adr: null, author: null, date: "2026-01-01T00:00:00Z" },
      suppressed: false,
    });
    fs.writeFileSync(
      path.join(dir, DECISIONS_FILE),
      [good, "{not json at all", JSON.stringify({ origin: "mined" }), JSON.stringify(["an array"]), ""].join("\n"),
    );

    const result = await importDecisions(store, dir, { force: true });
    expect(result.imported).toBe(1);
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings[0]).toContain("not valid JSON");
    expect(result.warnings[1]).toContain("missing external_id");
    expect(result.warnings[2]).toContain("not a JSON object");
    // The line numbers point at the actual lines, so a reviewer can find them.
    expect(result.warnings[0]).toContain(`${DECISIONS_FILE}:2`);
  });

  it("ignores blank lines and a missing trailing newline", () => {
    const line = JSON.stringify({
      external_id: "d1",
      source: { date: "2026-01-01T00:00:00Z" },
    });
    const { records, warnings } = parseDecisions(`\n${line}\n\n`);
    expect(records).toHaveLength(1);
    expect(warnings).toEqual([]);
    expect(parseDecisions(line).records).toHaveLength(1);
  });
});
