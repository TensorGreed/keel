import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { SqliteEventStore } from "../src/events/sqlite-store.js";
import type { KeelEvent } from "../src/events/store.js";
import {
  extractJsonObject,
  parseDecision,
  scoreDecision,
  type DecisionRecord,
} from "../src/mining/decision.js";
import { mineDecisions } from "../src/mining/mine.js";
import { MinerModelError, type DecisionModel } from "../src/mining/model.js";

// --- eval fixture set -------------------------------------------------------

interface Fixture {
  name: string;
  pr: {
    number: number;
    title: string;
    body: string;
    author: string;
    state: string;
    merged: boolean;
    url: string;
    files: string[];
    reviews: unknown[];
  };
  comments: { id: number; prNumber: number; inReplyTo: number | null; path: string; diffHunk: string; body: string; author: string }[];
  modelOutput: string;
  gold: DecisionRecord;
}

const FIXTURE_DIR = path.join(__dirname, "fixtures", "mining");
const FIXTURES: Fixture[] = fs
  .readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), "utf8")) as Fixture);

function prEvent(fx: Fixture): KeelEvent {
  return {
    kind: "pr",
    externalId: `o/r#${fx.pr.number}`,
    occurredAt: "2021-01-01T00:00:00Z",
    actor: fx.pr.author,
    title: fx.pr.title,
    payload: {
      number: fx.pr.number,
      state: fx.pr.state,
      merged: fx.pr.merged,
      author: fx.pr.author,
      body: fx.pr.body,
      url: fx.pr.url,
      reviews: fx.pr.reviews,
    },
    files: fx.pr.files,
  };
}

function commentEvents(fx: Fixture): KeelEvent[] {
  return fx.comments.map((c) => ({
    kind: "review_comment" as const,
    externalId: `o/r#comment-${c.id}`,
    occurredAt: "2021-01-01T00:00:00Z",
    actor: c.author,
    title: c.body,
    payload: { prNumber: c.prNumber, id: c.id, inReplyTo: c.inReplyTo, path: c.path, diffHunk: c.diffHunk, body: c.body },
    files: [c.path],
  }));
}

function seed(store: SqliteEventStore, fx: Fixture): void {
  store.appendMany([prEvent(fx), ...commentEvents(fx)]);
}

/** A model that never touches the network; returns a canned response per prompt. */
class FakeModel implements DecisionModel {
  readonly name = "fake";
  constructor(private readonly respond: (prompt: string) => string) {}
  async complete(prompt: string): Promise<string> {
    return this.respond(prompt);
  }
}

// --- parsing ----------------------------------------------------------------

describe("parseDecision", () => {
  it("parses each fixture's model output to its gold record (fences and prose tolerated)", () => {
    for (const fx of FIXTURES) {
      expect(parseDecision(fx.modelOutput), fx.name).toEqual(fx.gold);
    }
  });

  it("defaults missing fields and infers hasDecision from summary", () => {
    expect(parseDecision('{"summary": "did a thing"}')).toEqual({
      hasDecision: true,
      summary: "did a thing",
      rationale: "",
      alternatives: [],
      files: [],
      confidence: "low",
    });
    expect((parseDecision('{"summary": ""}') as DecisionRecord).hasDecision).toBe(false);
  });

  it("returns an error when there is no JSON object", () => {
    expect("error" in parseDecision("I could not determine a decision.")).toBe(true);
  });
});

describe("extractJsonObject", () => {
  it("pulls the first balanced object out of fenced or prose text", () => {
    expect(extractJsonObject('```json\n{"a": {"b": 1}}\n```')).toBe('{"a": {"b": 1}}');
    expect(extractJsonObject('prefix {"x": "}"} suffix')).toBe('{"x": "}"}'); // brace inside a string
    expect(extractJsonObject("no object here")).toBeNull();
  });

  it("strips a reasoning model's <think> scratchpad (which can contain braces) before scanning", () => {
    // Without the strip, the first `{` is inside the think block → invalid JSON.
    expect(extractJsonObject('<think>emit {summary, rationale} as JSON</think>\n{"a": 1}')).toBe('{"a": 1}');
  });
});

// --- eval metric ------------------------------------------------------------

describe("scoreDecision", () => {
  it("scores an identical record as 1", () => {
    for (const fx of FIXTURES) {
      expect(scoreDecision(fx.gold, fx.gold).score, fx.name).toBe(1);
    }
  });

  it("penalizes a degraded prediction", () => {
    const gold = FIXTURES.find((f) => f.gold.hasDecision)!.gold;
    const degraded: DecisionRecord = { ...gold, summary: "something entirely unrelated to the gold", rationale: "" };
    expect(scoreDecision(degraded, gold).score).toBeLessThan(1);
  });

  it("zeroes the score when hasDecision disagrees", () => {
    const gold = FIXTURES.find((f) => f.gold.hasDecision)!.gold;
    const wrong: DecisionRecord = { ...gold, hasDecision: false };
    expect(scoreDecision(wrong, gold)).toMatchObject({ score: 0, hasDecisionMatch: false });
  });
});

// --- end-to-end mining ------------------------------------------------------

describe("mineDecisions", () => {
  it("stores a grounded decision event for each real decision", async () => {
    for (const fx of FIXTURES.filter((f) => f.gold.hasDecision)) {
      const store = new SqliteEventStore(":memory:");
      seed(store, fx);
      const result = await mineDecisions(store, new FakeModel(() => fx.modelOutput));
      expect(result.mined, fx.name).toBe(1);

      const decisions = await store.byKind("decision");
      expect(decisions.length).toBe(1);
      const d = decisions[0]!;
      expect(d.externalId).toBe(`decision:o/r#${fx.pr.number}`);
      expect(d.title).toBe(fx.gold.summary);
      expect(d.payload["rationale"]).toBe(fx.gold.rationale);
      expect(d.payload["alternatives"]).toEqual(fx.gold.alternatives);
      expect(d.payload["sourcePr"]).toBe(`o/r#${fx.pr.number}`);
      // Grounded to the PR's real files; the model's list is advisory in the payload.
      expect([...(d.files ?? [])].sort()).toEqual([...fx.pr.files].sort());
      expect(d.payload["mentionedFiles"]).toEqual(fx.gold.files);
      store.close();
    }
  });

  it("stores nothing for a PR with no decision", async () => {
    const fx = FIXTURES.find((f) => !f.gold.hasDecision)!;
    const store = new SqliteEventStore(":memory:");
    seed(store, fx);
    const result = await mineDecisions(store, new FakeModel(() => fx.modelOutput));
    expect(result.mined).toBe(0);
    expect(result.noDecision).toBe(1);
    expect((await store.byKind("decision")).length).toBe(0);
    store.close();
  });

  it("is idempotent: a re-run skips already-mined PRs", async () => {
    const fx = FIXTURES.find((f) => f.gold.hasDecision)!;
    const store = new SqliteEventStore(":memory:");
    seed(store, fx);
    await mineDecisions(store, new FakeModel(() => fx.modelOutput));

    const second = await mineDecisions(store, new FakeModel(() => fx.modelOutput));
    expect(second.mined).toBe(0);
    expect(second.skipped).toBe(1);
    expect((await store.byKind("decision")).length).toBe(1);
    store.close();
  });

  it("counts a model error without throwing, and stores nothing", async () => {
    const fx = FIXTURES.find((f) => f.gold.hasDecision)!;
    const store = new SqliteEventStore(":memory:");
    seed(store, fx);
    const result = await mineDecisions(
      store,
      new FakeModel(() => {
        throw new MinerModelError("connection refused");
      }),
    );
    expect(result.errors).toBe(1);
    expect(result.mined).toBe(0);
    expect((await store.byKind("decision")).length).toBe(0);
    store.close();
  });

  it("counts unparseable model output as an error", async () => {
    const fx = FIXTURES.find((f) => f.gold.hasDecision)!;
    const store = new SqliteEventStore(":memory:");
    seed(store, fx);
    const result = await mineDecisions(store, new FakeModel(() => "the model rambled without any JSON"));
    expect(result.errors).toBe(1);
    expect(result.mined).toBe(0);
    store.close();
  });
});
