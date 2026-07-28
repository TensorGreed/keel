import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "../src/events/sqlite-store.js";
import type { KeelEvent } from "../src/events/store.js";
import { mineDecisions } from "../src/mining/mine.js";
import { MinerModelError, type DecisionModel } from "../src/mining/model.js";

const DECISION = '{"hasDecision":true,"summary":"chose X","rationale":"because Y","alternatives":[],"confidence":"high"}';
const NO_DECISION = '{"hasDecision":false,"summary":"","rationale":"","alternatives":[],"confidence":"low"}';

function pr(n: number, updatedAt: string): KeelEvent {
  return {
    kind: "pr",
    externalId: `o/r#${n}`,
    occurredAt: "2021-01-01T00:00:00Z",
    actor: "alice",
    title: `PR ${n}`,
    payload: { number: n, state: "closed", merged: true, url: `https://github.com/o/r/pull/${n}`, updatedAt, reviews: [] },
    files: [`f${n}.ts`],
  };
}

/** A model that records how many times it was asked (i.e. how many model calls happened). */
class CountingModel implements DecisionModel {
  readonly name = "counting";
  calls = 0;
  constructor(private readonly respond: (prompt: string, call: number) => string = () => NO_DECISION) {}
  async complete(prompt: string): Promise<string> {
    this.calls++;
    return this.respond(prompt, this.calls);
  }
}

describe("incremental mining", () => {
  it("does not re-mine a no-decision PR on re-run (the cost fix)", async () => {
    const store = new SqliteEventStore(":memory:");
    store.appendMany([pr(1, "2021-02-01T00:00:00Z")]);
    const model = new CountingModel(() => NO_DECISION);

    const first = await mineDecisions(store, model);
    expect(first).toMatchObject({ noDecision: 1, mined: 0, skipped: 0 });
    expect(model.calls).toBe(1);

    const second = await mineDecisions(store, model);
    expect(second).toMatchObject({ noDecision: 0, mined: 0, skipped: 1 });
    expect(model.calls).toBe(1); // no second model call — the whole point
    store.close();
  });

  it("does not re-mine a PR that already produced a decision", async () => {
    const store = new SqliteEventStore(":memory:");
    store.appendMany([pr(1, "2021-02-01T00:00:00Z")]);
    const model = new CountingModel(() => DECISION);

    await mineDecisions(store, model);
    const second = await mineDecisions(store, model);
    expect(second).toMatchObject({ mined: 0, skipped: 1 });
    expect(model.calls).toBe(1);
    store.close();
  });

  it("mines only newly ingested PRs", async () => {
    const store = new SqliteEventStore(":memory:");
    store.appendMany([pr(1, "2021-01-01T00:00:00Z")]);
    const model = new CountingModel(() => DECISION);
    await mineDecisions(store, model);

    store.appendMany([pr(2, "2021-01-02T00:00:00Z")]);
    const second = await mineDecisions(store, model);
    expect(second).toMatchObject({ mined: 1, skipped: 1 });
    expect(model.calls).toBe(2); // PR1 once, PR2 once — never twice
    store.close();
  });

  it("re-mines a no-decision PR whose updated_at advanced past when it was mined", async () => {
    const store = new SqliteEventStore(":memory:");
    store.appendMany([pr(1, "2021-02-01T00:00:00Z")]);
    const model = new CountingModel(() => NO_DECISION);
    await mineDecisions(store, model);

    // Simulate: the PR changed after we mined it (its mark predates its current updated_at).
    store.markPrMined("o/r#1", "2021-01-01T00:00:00Z");
    const second = await mineDecisions(store, model);
    expect(second).toMatchObject({ noDecision: 1, skipped: 0 });
    expect(model.calls).toBe(2);
    store.close();
  });

  it("defers PRs past the per-run cap, newest-updated first, and resumes next run", async () => {
    const store = new SqliteEventStore(":memory:");
    store.appendMany([pr(1, "2021-01-01T00:00:00Z"), pr(2, "2021-01-02T00:00:00Z"), pr(3, "2021-01-03T00:00:00Z")]);
    const model = new CountingModel(() => NO_DECISION);

    const first = await mineDecisions(store, model, { limit: 2 });
    expect(first).toMatchObject({ noDecision: 2, deferred: 1 });
    expect(model.calls).toBe(2);
    // The two freshest were taken first; PR1 (oldest) is the deferred one.
    expect([...store.minedPrs().keys()].sort()).toEqual(["o/r#2", "o/r#3"]);

    const second = await mineDecisions(store, model, { limit: 2 });
    expect(second).toMatchObject({ noDecision: 1, deferred: 0 });
    expect(model.calls).toBe(3);
    expect([...store.minedPrs().keys()].sort()).toEqual(["o/r#1", "o/r#2", "o/r#3"]);
    store.close();
  });

  it("does not mark a PR mined when the model errors, so it retries next run", async () => {
    const store = new SqliteEventStore(":memory:");
    store.appendMany([pr(1, "2021-02-01T00:00:00Z")]);
    const model = new CountingModel((_p, call) => {
      if (call === 1) throw new MinerModelError("boom");
      return DECISION;
    });

    const first = await mineDecisions(store, model);
    expect(first).toMatchObject({ errors: 1, mined: 0 });
    expect(store.minedPrs().size).toBe(0); // not marked

    const second = await mineDecisions(store, model);
    expect(second).toMatchObject({ mined: 1, errors: 0 });
    expect(model.calls).toBe(2);
    store.close();
  });
});
