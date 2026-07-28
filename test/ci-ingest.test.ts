import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "../src/events/sqlite-store.js";
import { ingestCiReports } from "../src/ci/ingest.js";

function report(cases: { name: string; file?: string; status: "passed" | "failed" }[]): string {
  const body = cases
    .map((c) => {
      const attrs = `name="${c.name}"${c.file ? ` file="${c.file}"` : ""}`;
      return c.status === "failed" ? `<testcase ${attrs}><failure message="boom"/></testcase>` : `<testcase ${attrs}/>`;
    })
    .join("\n");
  return `<testsuite name="s" timestamp="2021-06-01T00:00:00Z">${body}</testsuite>`;
}

describe("ingestCiReports", () => {
  it("records a run with per-test results, counts, and touched files", async () => {
    const store = new SqliteEventStore(":memory:");
    const r = ingestCiReports(
      store,
      [{ path: "r.xml", xml: report([
        { name: "a", file: "src/a.test.ts", status: "passed" },
        { name: "b", file: "src/b.test.ts", status: "failed" },
      ]) }],
      { sha: "sha1", runId: "run-1" },
    );
    expect(r).toMatchObject({ runId: "run-1", sha: "sha1", tests: 2, failed: 1, files: 2, ingested: 1 });

    const events = await store.byKind("ci_run");
    expect(events).toHaveLength(1);
    const p = events[0]!.payload as { runId: string; sha: string; tests: { name: string; status: string }[] };
    expect(p.runId).toBe("run-1");
    expect(p.tests.map((t) => t.status).sort()).toEqual(["failed", "passed"]);
    expect(events[0]!.files).toEqual(["src/a.test.ts", "src/b.test.ts"]);
    store.close();
  });

  it("is idempotent for identical reports but records a flipped re-run as a new observation", async () => {
    const store = new SqliteEventStore(":memory:");
    const passing = report([{ name: "flaky", file: "t.test.ts", status: "passed" }]);
    const failing = report([{ name: "flaky", file: "t.test.ts", status: "failed" }]);

    // Same sha, no run-id -> id derived from content. Identical content dedupes...
    expect(ingestCiReports(store, [{ path: "1", xml: passing }], { sha: "s" }).ingested).toBe(1);
    expect(ingestCiReports(store, [{ path: "1", xml: passing }], { sha: "s" }).ingested).toBe(0);
    // ...a flipped re-run on the same sha hashes differently -> a distinct ci_run.
    expect(ingestCiReports(store, [{ path: "1", xml: failing }], { sha: "s" }).ingested).toBe(1);

    expect(await store.byKind("ci_run")).toHaveLength(2);
    store.close();
  });

  it("combines several report files (a sharded run) into one ci_run", async () => {
    const store = new SqliteEventStore(":memory:");
    const r = ingestCiReports(
      store,
      [
        { path: "shard1.xml", xml: report([{ name: "a", file: "a.test.ts", status: "passed" }]) },
        { path: "shard2.xml", xml: report([{ name: "b", file: "b.test.ts", status: "passed" }]) },
      ],
      { sha: "s", runId: "run-x" },
    );
    expect(r).toMatchObject({ reports: 2, tests: 2, files: 2, ingested: 1 });
    expect(await store.byKind("ci_run")).toHaveLength(1);
    store.close();
  });
});
