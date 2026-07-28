import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "../src/events/sqlite-store.js";
import { GitHubError, type GitHubClient, type GitHubResponse } from "../src/github/client.js";
import { ingestGitHub } from "../src/github/ingest.js";

// --- recorded fixtures (never the network) ----------------------------------

/** A repo's PR data, keyed for the fake client to serve by endpoint. */
interface FakeRepo {
  pulls: unknown[]; // returned newest-updated first, as GitHub sorts them
  files: Record<number, unknown[]>;
  reviews: Record<number, unknown[]>;
  comments: Record<number, unknown[]>;
}

const REPO: FakeRepo = {
  pulls: [
    {
      number: 2,
      title: "Guard against empty input",
      body: "Fixes a crash.",
      state: "open",
      merged_at: null,
      created_at: "2021-01-20T00:00:00Z",
      updated_at: "2021-02-01T00:00:00Z",
      user: { login: "alice" },
      html_url: "https://github.com/o/r/pull/2",
      base: { ref: "main" },
      head: { ref: "fix-empty" },
    },
    {
      number: 1,
      title: "Initial parser",
      body: "",
      state: "closed",
      merged_at: "2021-01-15T00:00:00Z",
      created_at: "2021-01-10T00:00:00Z",
      updated_at: "2021-01-15T00:00:00Z",
      user: { login: "bob" },
      html_url: "https://github.com/o/r/pull/1",
      base: { ref: "main" },
      head: { ref: "parser" },
    },
  ],
  files: {
    2: [{ filename: "src/foo.ts" }],
    1: [{ filename: "src/bar.ts" }],
  },
  reviews: {
    2: [{ id: 900, state: "APPROVED", body: "LGTM", submitted_at: "2021-01-31T00:00:00Z", user: { login: "bob" } }],
    1: [],
  },
  comments: {
    2: [
      { id: 10, in_reply_to_id: null, path: "src/foo.ts", diff_hunk: "@@ -1 +1 @@", body: "this can be null here", created_at: "2021-01-30T00:00:00Z", commit_id: "abc", html_url: "https://github.com/o/r/pull/2#c10", user: { login: "bob" } },
      { id: 11, in_reply_to_id: 10, path: "src/foo.ts", diff_hunk: "@@ -1 +1 @@", body: "good catch, fixed", created_at: "2021-01-30T01:00:00Z", commit_id: "def", html_url: "https://github.com/o/r/pull/2#c11", user: { login: "alice" } },
    ],
    1: [],
  },
};

class FakeGitHubClient implements GitHubClient {
  readonly authenticated: boolean;
  readonly calls: string[] = [];

  constructor(
    private readonly repo: FakeRepo,
    private readonly opts: {
      authenticated?: boolean;
      rateLimitRemaining?: number;
      failOnPath?: string;
      failWith?: GitHubError;
    } = {},
  ) {
    this.authenticated = opts.authenticated ?? false;
  }

  async get<T>(pathOrUrl: string): Promise<GitHubResponse<T>> {
    this.calls.push(pathOrUrl);
    if (this.opts.failOnPath && pathOrUrl.includes(this.opts.failOnPath)) {
      throw this.opts.failWith ?? new GitHubError(500, "GitHub 500: boom");
    }
    const rateLimit = { remaining: this.opts.rateLimitRemaining ?? 5000, limit: 5000, reset: 1_700_000_000 };
    const respond = (data: unknown): GitHubResponse<T> => ({ data: data as T, nextPage: null, rateLimit });

    if (/\/pulls\?/.test(pathOrUrl)) return respond(this.repo.pulls);
    const m = /\/pulls\/(\d+)\/(files|reviews|comments)/.exec(pathOrUrl);
    if (m) {
      const n = Number(m[1]);
      const kind = m[2] as "files" | "reviews" | "comments";
      return respond(this.repo[kind][n] ?? []);
    }
    return respond([]);
  }

  // ingestion never writes; present only to satisfy the GitHubClient contract.
  post<T>(): Promise<GitHubResponse<T>> {
    throw new Error("FakeGitHubClient.post is not used by ingestion");
  }
}

const REF = { owner: "o", repo: "r" };
const CURSOR_KEY = "github:o/r:pr_updated_at";

// --- tests ------------------------------------------------------------------

describe("GitHub PR ingestion", () => {
  it("backfills PRs, review comments, and touched files", async () => {
    const store = new SqliteEventStore(":memory:");
    const result = await ingestGitHub(store, new FakeGitHubClient(REPO), REF);

    expect(result.mode).toBe("backfill");
    expect(result.prs).toBe(2);
    expect(result.reviewComments).toBe(2);
    expect(result.ingested).toBe(4); // 2 PRs + 2 review comments

    const prs = await store.byKind("pr");
    expect(prs.map((p) => p.title)).toEqual(["Guard against empty input", "Initial parser"]);
    const pr2 = prs[0]!;
    expect(pr2.actor).toBe("alice");
    expect(pr2.externalId).toBe("o/r#2");
    expect(pr2.payload["merged"]).toBe(false);
    expect((pr2.payload["reviews"] as unknown[]).length).toBe(1);
    expect(pr2.files).toEqual(["src/foo.ts"]);

    const comments = await store.byKind("review_comment");
    expect(comments.map((c) => c.payload["id"]).sort()).toEqual([10, 11]);
    const reply = comments.find((c) => c.payload["id"] === 11)!;
    expect(reply.payload["inReplyTo"]).toBe(10); // thread structure preserved
    expect(reply.payload["diffHunk"]).toBe("@@ -1 +1 @@");
    expect(reply.payload["path"]).toBe("src/foo.ts");

    // discussion is linked to code: querying the file returns the PR and its comments
    const onFoo = await store.byFile("src/foo.ts");
    expect(onFoo.length).toBe(3);
    store.close();
  });

  it("advances the cursor to the newest updated_at", async () => {
    const store = new SqliteEventStore(":memory:");
    const result = await ingestGitHub(store, new FakeGitHubClient(REPO), REF);
    expect(result.cursor).toBe("2021-02-01T00:00:00Z");
    expect(store.getMeta(CURSOR_KEY)).toBe("2021-02-01T00:00:00Z");
    store.close();
  });

  it("is idempotent: a second run ingests nothing new", async () => {
    const store = new SqliteEventStore(":memory:");
    await ingestGitHub(store, new FakeGitHubClient(REPO), REF);

    const second = await ingestGitHub(store, new FakeGitHubClient(REPO), REF);
    expect(second.mode).toBe("incremental");
    expect(second.ingested).toBe(0);
    expect(second.prs).toBe(0); // stops at the cursor before fetching any sub-resources
    expect((await store.byKind("pr")).length).toBe(2);
    store.close();
  });

  it("re-ingests a PR whose updated_at advanced past the cursor", async () => {
    const store = new SqliteEventStore(":memory:");
    await ingestGitHub(store, new FakeGitHubClient(REPO), REF);

    // PR #2 gets a new comment; its updated_at bumps past the cursor.
    const bumped: FakeRepo = JSON.parse(JSON.stringify(REPO));
    (bumped.pulls[0] as { updated_at: string }).updated_at = "2021-03-01T00:00:00Z";
    (bumped.comments[2] as unknown[]).push({
      id: 12, in_reply_to_id: null, path: "src/foo.ts", diff_hunk: "@@ -2 +2 @@", body: "one more", created_at: "2021-03-01T00:00:00Z", commit_id: "ghi", html_url: "u", user: { login: "bob" },
    });

    const result = await ingestGitHub(store, new FakeGitHubClient(bumped), REF);
    expect(result.prs).toBe(1); // only the changed PR
    expect(result.ingested).toBe(1); // the PR event is a dup (IGNORE); only the new comment is inserted
    expect((await store.byKind("review_comment")).length).toBe(3);
    expect(store.getMeta(CURSOR_KEY)).toBe("2021-03-01T00:00:00Z");
    store.close();
  });

  it("stops cleanly on a rate limit and does not advance the cursor", async () => {
    const store = new SqliteEventStore(":memory:");
    const client = new FakeGitHubClient(REPO, {
      failOnPath: "/pulls/2/reviews",
      failWith: new GitHubError(403, "GitHub 403: API rate limit exceeded", { remaining: 0, limit: 60, reset: 1_700_000_000 }),
    });
    const result = await ingestGitHub(store, client, REF);

    expect(result.stopped).toBe("rate-limit");
    expect(result.rateReset).toBe(1_700_000_000);
    expect(result.error).toBeUndefined(); // a clean stop, not an error
    expect(store.getMeta(CURSOR_KEY)).toBeUndefined(); // safe to resume: cursor untouched
    store.close();
  });

  it("surfaces an HTTP error as a clean message, not a stack trace", async () => {
    const store = new SqliteEventStore(":memory:");
    const client = new FakeGitHubClient(REPO, {
      failOnPath: "/pulls?",
      failWith: new GitHubError(500, "GitHub 500: Internal Server Error"),
    });
    const result = await ingestGitHub(store, client, REF);

    expect(result.error).toBe("GitHub 500: Internal Server Error");
    expect(result.ingested).toBe(0);
    expect(store.getMeta(CURSOR_KEY)).toBeUndefined();
    store.close();
  });

  it("reports whether the client was authenticated", async () => {
    const store = new SqliteEventStore(":memory:");
    const result = await ingestGitHub(store, new FakeGitHubClient(REPO, { authenticated: true }), REF);
    expect(result.authenticated).toBe(true);
    store.close();
  });
});
