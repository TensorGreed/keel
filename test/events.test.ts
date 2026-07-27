import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteEventStore } from "../src/events/sqlite-store.js";
import { ingestCommits } from "../src/events/ingest.js";

/** Build a throwaway git repo with deterministic identities and author dates. */
function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-events-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "dev@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Dev"], { cwd: dir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  return dir;
}

/** Commit `files` (name -> contents) with a fixed author date so ordering is stable. */
function commit(dir: string, subject: string, isoDate: string, files: Record<string, string>): void {
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
    execFileSync("git", ["add", name], { cwd: dir });
  }
  execFileSync("git", ["commit", "-m", subject], {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate },
  });
}

describe("SqliteEventStore commit ingestion", () => {
  let repo: string;
  let dbPath: string;

  beforeAll(() => {
    repo = initRepo();
    commit(repo, "add a", "2021-01-01T00:00:00Z", { "a.ts": "export const a = 1;\n" });
    commit(repo, "add b, touch a", "2021-01-02T00:00:00Z", {
      "b.ts": "export const b = 2;\n",
      "a.ts": "export const a = 11;\n",
    });
    commit(repo, "add c", "2021-01-03T00:00:00Z", { "src/c.ts": "export const c = 3;\n" });
    dbPath = path.join(repo, ".keel", "events.db");
  });

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("populates events and event_files from git", async () => {
    const store = new SqliteEventStore(dbPath);
    const result = await ingestCommits(store, repo);
    expect(result.mode).toBe("backfill");
    expect(result.ingested).toBe(3);
    expect(result.scanned).toBe(3);

    const commits = await store.byKind("commit");
    expect(commits.map((c) => c.title)).toEqual(["add c", "add b, touch a", "add a"]);

    const newest = commits[0]!;
    expect(newest.externalId).toMatch(/^[0-9a-f]{40}$/);
    expect(newest.actor).toBe("Dev");
    expect(newest.occurredAt).toBe("2021-01-03T00:00:00+00:00"); // git %aI renders Z as +00:00
    expect(newest.files).toEqual(["src/c.ts"]);
    expect(newest.payload["email"]).toBe("dev@example.com");
    store.close();
  });

  it("stores the touched files, both sides of a change", async () => {
    const store = new SqliteEventStore(dbPath);
    // a.ts was touched by two commits, newest-first.
    const forA = await store.byFile("a.ts");
    expect(forA.map((c) => c.title)).toEqual(["add b, touch a", "add a"]);
    expect((await store.byFile("b.ts")).map((c) => c.title)).toEqual(["add b, touch a"]);
    expect((await store.byFile("src/c.ts")).map((c) => c.title)).toEqual(["add c"]);
    store.close();
  });

  it("is idempotent: re-ingesting inserts no duplicates", async () => {
    const store = new SqliteEventStore(dbPath);
    const result = await ingestCommits(store, repo);
    expect(result.ingested).toBe(0);
    expect((await store.byKind("commit")).length).toBe(3);
    // event_files didn't grow either.
    expect((await store.byFile("a.ts")).length).toBe(2);
    store.close();
  });

  it("ingests only new commits incrementally, across a reopen", async () => {
    commit(repo, "add d", "2021-01-04T00:00:00Z", { "d.ts": "export const d = 4;\n" });

    const store = new SqliteEventStore(dbPath);
    const result = await ingestCommits(store, repo);
    expect(result.mode).toBe("incremental");
    expect(result.ingested).toBe(1);
    expect(result.scanned).toBe(1);

    const commits = await store.byKind("commit");
    expect(commits.length).toBe(4);
    expect(commits[0]!.title).toBe("add d");
    store.close();
  });

  it("re-runs a full backfill when the cursor no longer resolves", async () => {
    const store = new SqliteEventStore(dbPath);
    store.setMeta("git.last_sha", "0".repeat(40)); // a sha that isn't in this repo
    const result = await ingestCommits(store, repo);
    expect(result.mode).toBe("backfill");
    expect(result.ingested).toBe(0); // all four already present → idempotent
    expect((await store.byKind("commit")).length).toBe(4);
    store.close();
  });

  it("does not throw on a non-git directory", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "keel-nogit-"));
    try {
      const store = new SqliteEventStore(path.join(empty, ".keel", "events.db"));
      const result = await ingestCommits(store, empty);
      expect(result.mode).toBe("skipped");
      expect(result.ingested).toBe(0);
      store.close();
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
