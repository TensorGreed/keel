import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "../src/events/sqlite-store.js";
import type { KeelEvent } from "../src/events/store.js";
import { authorShares, isBot, suggestReviewers } from "../src/ownership/ownership.js";

// Fixed "now" so recency weighting is deterministic.
const NOW = Date.parse("2021-07-01T00:00:00Z");
let seq = 0;
function commit(author: string, files: string[], date: string): KeelEvent {
  return { kind: "commit", externalId: `c${seq++}`, occurredAt: date, actor: author, title: "c", payload: {}, files };
}
function pr(author: string, files: string[], date: string): KeelEvent {
  return { kind: "pr", externalId: `p${seq++}`, occurredAt: date, actor: author, title: "pr", payload: {}, files };
}

describe("isBot", () => {
  it("recognizes common bots and the [bot] suffix", () => {
    expect(isBot("dependabot[bot]")).toBe(true);
    expect(isBot("renovate[bot]")).toBe(true);
    expect(isBot("github-actions[bot]")).toBe(true);
    expect(isBot("snyk-bot")).toBe(true);
    expect(isBot("alice")).toBe(false);
  });
});

describe("authorShares", () => {
  it("weights recent authorship above old, and sums per author", async () => {
    const store = new SqliteEventStore(":memory:");
    store.appendMany([
      commit("alice", ["a.ts"], "2021-06-25T00:00:00Z"), // recent
      commit("alice", ["a.ts"], "2021-06-20T00:00:00Z"), // recent
      commit("bob", ["a.ts"], "2019-01-01T00:00:00Z"), // ancient (~2.5y, heavily decayed)
    ]);
    const shares = await authorShares(store, "a.ts", NOW);
    expect(shares[0]!.author).toBe("alice");
    expect(shares[0]!.share).toBeGreaterThan(0.9); // alice dominates; bob's old commit barely counts
    expect(shares[0]!.events).toBe(2);
    expect(shares.map((s) => s.author)).toContain("bob");
    store.close();
  });

  it("excludes bots and events without an author", async () => {
    const store = new SqliteEventStore(":memory:");
    store.appendMany([commit("alice", ["a.ts"], "2021-06-01T00:00:00Z"), commit("dependabot[bot]", ["a.ts"], "2021-06-30T00:00:00Z")]);
    const shares = await authorShares(store, "a.ts", NOW);
    expect(shares.map((s) => s.author)).toEqual(["alice"]);
    store.close();
  });

  it("returns [] for a file no human has touched", async () => {
    const store = new SqliteEventStore(":memory:");
    expect(await authorShares(store, "new.ts", NOW)).toEqual([]);
    store.close();
  });
});

describe("suggestReviewers", () => {
  it("ranks by authorship across the touched files, using commits and PRs", async () => {
    const store = new SqliteEventStore(":memory:");
    store.appendMany([
      commit("alice", ["a.ts", "b.ts"], "2021-06-20T00:00:00Z"),
      pr("alice", ["a.ts"], "2021-06-25T00:00:00Z"),
      commit("bob", ["b.ts"], "2021-06-10T00:00:00Z"),
    ]);
    const revs = await suggestReviewers(store, ["a.ts", "b.ts"], { nowMs: NOW });
    expect(revs[0]!.reviewer).toBe("alice");
    expect(revs[0]!.filesKnown).toEqual(["a.ts", "b.ts"]);
    expect(revs[0]!.reason).toContain("2 of 2 touched file(s)");
    expect(revs.map((r) => r.reviewer)).toEqual(["alice", "bob"]);
    // shares are normalized across the suggestions
    expect(revs.reduce((s, r) => s + r.share, 0)).toBeCloseTo(1, 5);
    store.close();
  });

  it("excludes the given author, the committer, and bots", async () => {
    const store = new SqliteEventStore(":memory:");
    store.appendMany([
      commit("alice", ["a.ts"], "2021-06-20T00:00:00Z"),
      commit("bob", ["a.ts"], "2021-06-21T00:00:00Z"),
      commit("dependabot[bot]", ["a.ts"], "2021-06-30T00:00:00Z"),
    ]);
    const revs = await suggestReviewers(store, ["a.ts"], { nowMs: NOW, exclude: new Set(["alice"]) });
    expect(revs.map((r) => r.reviewer)).toEqual(["bob"]); // alice excluded, bot dropped
    store.close();
  });

  it("honors the limit", async () => {
    const store = new SqliteEventStore(":memory:");
    store.appendMany([
      commit("alice", ["a.ts"], "2021-06-20T00:00:00Z"),
      commit("bob", ["a.ts"], "2021-06-19T00:00:00Z"),
      commit("carol", ["a.ts"], "2021-06-18T00:00:00Z"),
    ]);
    expect((await suggestReviewers(store, ["a.ts"], { nowMs: NOW, limit: 2 })).length).toBe(2);
    store.close();
  });
});
