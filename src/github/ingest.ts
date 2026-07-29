/**
 * GitHub connector: backfill pull requests + review threads into the event log. Plain ETL
 * — no model calls (see CLAUDE.md); the decision miner consumes this data next.
 *
 * PRs are listed newest-updated first. A per-repo cursor on updated_at (in the meta table)
 * makes re-runs ingest only changed PRs: paging stops as soon as it reaches a PR at or below
 * the cursor. Writes are idempotent (UNIQUE(kind, external_id) + INSERT OR IGNORE). Pages
 * per run are capped, and the cursor advances only on a clean, complete run — so an
 * interrupted backfill (page cap or rate limit) re-runs and continues rather than skipping
 * the PRs it never reached. Partial work is written and safe.
 */
import type { KeelEvent } from "../events/store.js";
import type { SqliteEventStore } from "../events/sqlite-store.js";
import { GitHubError, type GitHubClient, type GitHubResponse } from "./client.js";
import { repoSlug, type RepoRef } from "./remote.js";

const DEFAULT_MAX_PAGES = 10;
/** Emit a progress line at least this often during a page's detail fetches (a page can hold 100
 *  PRs, each 3 sub-requests — without this, a single page can go quiet for minutes). */
const PROGRESS_EVERY_PRS = 25;

// Minimal shapes of the GitHub REST responses we read.
interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  state: string;
  merged_at: string | null;
  created_at: string;
  updated_at: string;
  user: { login: string } | null;
  html_url: string;
  base?: { ref?: string };
  head?: { ref?: string };
}
interface PullFile {
  filename: string;
}
interface Review {
  id: number;
  state: string;
  body: string | null;
  submitted_at: string | null;
  user: { login: string } | null;
}
interface ReviewComment {
  id: number;
  in_reply_to_id?: number | null;
  path: string;
  diff_hunk: string;
  body: string;
  created_at: string;
  commit_id?: string;
  html_url: string;
  user: { login: string } | null;
}

export interface GitHubIngestResult {
  repo: string;
  mode: "backfill" | "incremental";
  /** PRs processed this run */
  prs: number;
  /** review comments seen this run */
  reviewComments: number;
  /** events newly inserted (excludes idempotent duplicates) */
  ingested: number;
  authenticated: boolean;
  /** the updated_at high-water mark, when the run completed cleanly */
  cursor?: string;
  /** why the run stopped early, if it did */
  stopped?: "page-cap" | "rate-limit" | "timeout";
  /** epoch seconds when a hit rate limit resets */
  rateReset?: number;
  /** a clean API/network error message, if the run failed part-way */
  error?: string;
}

export interface GitHubIngestOptions {
  maxPages?: number;
  /** called with a human-readable progress line (no prefix) during backfill — the CLI writes it to
   *  stderr, so a multi-minute run is never mistaken for a hang. */
  onProgress?: (message: string) => void;
}

function envMaxPages(): number | undefined {
  const value = Number(process.env["KEEL_INGEST_MAX_PAGES"]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/** Follow pagination for a sub-resource, collecting all items. Throws a rate-limit
 *  GitHubError if the budget runs out mid-pagination, so the caller stops cleanly. */
async function fetchAll<T>(client: GitHubClient, path: string): Promise<T[]> {
  const items: T[] = [];
  let page: string | null = path;
  while (page) {
    const resp: GitHubResponse<T[]> = await client.get<T[]>(page);
    items.push(...resp.data);
    page = resp.nextPage;
    if (page && resp.rateLimit && resp.rateLimit.remaining <= 0) {
      throw new GitHubError(403, "rate limit exhausted mid-pagination", resp.rateLimit);
    }
  }
  return items;
}

function prEvent(ref: RepoRef, pr: PullRequest, files: string[], reviews: Review[]): KeelEvent {
  const event: KeelEvent = {
    kind: "pr",
    externalId: `${repoSlug(ref)}#${pr.number}`,
    occurredAt: pr.created_at,
    ...(pr.user ? { actor: pr.user.login } : {}),
    title: pr.title,
    payload: {
      number: pr.number,
      state: pr.state,
      merged: pr.merged_at !== null,
      mergedAt: pr.merged_at,
      author: pr.user?.login ?? null,
      body: pr.body ?? "",
      url: pr.html_url,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      baseRef: pr.base?.ref ?? null,
      headRef: pr.head?.ref ?? null,
      reviews: reviews.map((r) => ({
        id: r.id,
        state: r.state,
        author: r.user?.login ?? null,
        body: r.body ?? "",
        submittedAt: r.submitted_at,
      })),
    },
  };
  if (files.length > 0) event.files = [...new Set(files)];
  return event;
}

function reviewCommentEvent(ref: RepoRef, pr: PullRequest, comment: ReviewComment): KeelEvent {
  return {
    kind: "review_comment",
    externalId: `${repoSlug(ref)}#comment-${comment.id}`,
    occurredAt: comment.created_at,
    ...(comment.user ? { actor: comment.user.login } : {}),
    title: comment.body.split("\n", 1)[0] ?? "",
    payload: {
      prNumber: pr.number,
      id: comment.id,
      // thread structure: null for a top-level comment, else the comment it replies to.
      inReplyTo: comment.in_reply_to_id ?? null,
      path: comment.path,
      // the miner links discussion to code via the hunk + file path.
      diffHunk: comment.diff_hunk,
      commitId: comment.commit_id ?? null,
      body: comment.body,
      url: comment.html_url,
    },
    files: [comment.path],
  };
}

export async function ingestGitHub(
  store: SqliteEventStore,
  client: GitHubClient,
  ref: RepoRef,
  options: GitHubIngestOptions = {},
): Promise<GitHubIngestResult> {
  const maxPages = options.maxPages ?? envMaxPages() ?? DEFAULT_MAX_PAGES;
  const progress = (message: string): void => options.onProgress?.(message);
  const slug = repoSlug(ref);
  const cursorKey = `github:${slug}:pr_updated_at`;
  const cursor = store.getMeta(cursorKey);
  const mode: "backfill" | "incremental" = cursor ? "incremental" : "backfill";

  const events: KeelEvent[] = [];
  let prs = 0;
  let reviewComments = 0;
  let newestUpdated: string | null = cursor ?? null;
  let stopped: "page-cap" | "rate-limit" | "timeout" | undefined;
  let rateReset: number | undefined;
  let completed = false;
  let apiError: string | undefined;

  const base = `/repos/${ref.owner}/${ref.repo}/pulls`;
  let page: string | null = `${base}?state=all&sort=updated&direction=desc&per_page=100`;
  let listPages = 0;

  try {
    // Announce the auth mode + target up front, so a misconfiguration (wrong repo, invalid token) is
    // visible immediately rather than after a run of requests. The /user probe also validates a token.
    if (client.authenticated) {
      const user = await client.get<{ login?: string }>("/user");
      progress(`ingesting ${slug} as ${user.data.login ?? "an authenticated user"}`);
    } else {
      progress(`ingesting ${slug} unauthenticated — 60 requests/hour; set GITHUB_TOKEN for more`);
    }

    outer: while (page) {
      if (listPages >= maxPages) {
        stopped = "page-cap";
        break;
      }
      const resp: GitHubResponse<PullRequest[]> = await client.get<PullRequest[]>(page);
      listPages++;

      for (const pr of resp.data) {
        if (cursor && pr.updated_at <= cursor) {
          completed = true; // reached already-ingested territory
          break outer;
        }
        if (newestUpdated === null || pr.updated_at > newestUpdated) newestUpdated = pr.updated_at;

        const prPath = `${base}/${pr.number}`;
        const files = await fetchAll<PullFile>(client, `${prPath}/files?per_page=100`);
        const reviews = await fetchAll<Review>(client, `${prPath}/reviews?per_page=100`);
        const comments = await fetchAll<ReviewComment>(client, `${prPath}/comments?per_page=100`);

        events.push(prEvent(ref, pr, files.map((f) => f.filename), reviews));
        for (const comment of comments) events.push(reviewCommentEvent(ref, pr, comment));
        prs++;
        reviewComments += comments.length;
        // fine-grained progress within a page, so detail fetches never look like a stall
        if (prs % PROGRESS_EVERY_PRS === 0) progress(`  …${prs} PRs, ${reviewComments} comments so far`);
      }

      progress(`page ${listPages}/${maxPages}: ${prs} PRs, ${reviewComments} comments so far`);
      page = resp.nextPage;
      if (page && resp.rateLimit && resp.rateLimit.remaining <= 0) {
        stopped = "rate-limit";
        rateReset = resp.rateLimit.reset;
        break;
      }
      if (!page) completed = true;
    }
  } catch (err) {
    if (!(err instanceof GitHubError)) throw err;
    if (err.timedOut) {
      // A stalled request is a clean, resumable stop — the cursor stays put and re-running continues.
      stopped = "timeout";
    } else if (err.isRateLimit) {
      stopped = "rate-limit";
      if (err.rateLimit) rateReset = err.rateLimit.reset;
    } else {
      apiError = err.message; // surfaced as data, not a stack trace
    }
  }

  const ingested = store.appendMany(events);
  if (completed && stopped === undefined && newestUpdated) store.setMeta(cursorKey, newestUpdated);

  return {
    repo: slug,
    mode,
    prs,
    reviewComments,
    ingested,
    authenticated: client.authenticated,
    ...(completed && stopped === undefined && newestUpdated ? { cursor: newestUpdated } : {}),
    ...(stopped ? { stopped } : {}),
    ...(rateReset !== undefined ? { rateReset } : {}),
    ...(apiError ? { error: apiError } : {}),
  };
}
