/**
 * Decision miner: read PR + review-comment events from the event log, ask a model to
 * extract the decision behind each PR, and store the result as a `decision` event. This is
 * the offline pipeline — the only place model calls are allowed (see model.ts / CLAUDE.md).
 *
 * Idempotent: PRs already mined (a decision event already links to them) are skipped, so a
 * re-run only mines new PRs and never double-charges the model. Decision records are grounded
 * — they link to the files the PR actually touched (from the event log), not files the model
 * guessed; the model's own file list is kept in the payload as advisory.
 */
import type { EventStore, KeelEvent } from "../events/store.js";
import type { SqliteEventStore } from "../events/sqlite-store.js";
import { parseDecision } from "./decision.js";
import type { DecisionModel } from "./model.js";
import { MinerModelError } from "./model.js";
import { buildDecisionPrompt, type PrThread, type ThreadComment, type ThreadReview } from "./prompt.js";

export interface MineOptions {
  /** cap PRs mined this run (newest-updated first); default 200 */
  limit?: number;
  /** called with the number of PRs about to be mined, BEFORE any model call — lets the CLI warn
   *  about the cost of a large cloud run before a bill is incurred (see CLAUDE.md cost rules). */
  onPlan?: (count: number) => void;
}

export interface MineResult {
  model: string;
  /** PRs in the log */
  total: number;
  /** decision events newly stored */
  mined: number;
  /** PRs skipped because they were already mined/decided and unchanged (no model call) */
  skipped: number;
  /** PRs left for the next run because the per-run cap was hit */
  deferred: number;
  /** PRs the model judged to carry no decision */
  noDecision: number;
  /** PRs that failed (model error or unparseable output) — retried next run */
  errors: number;
}

const DEFAULT_LIMIT = 200;

/** The PR's updated_at (bumps on new comments/reviews), falling back to its created_at. */
function prUpdatedAt(pr: KeelEvent): string {
  const updated = pr.payload["updatedAt"];
  return typeof updated === "string" && updated !== "" ? updated : pr.occurredAt;
}

function log(message: string): void {
  process.stderr.write(`[keel] ${message}\n`);
}

function reviewsOf(pr: KeelEvent): ThreadReview[] {
  const raw = pr.payload["reviews"];
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => {
    const rec = (r ?? {}) as Record<string, unknown>;
    return {
      author: typeof rec["author"] === "string" ? rec["author"] : null,
      state: typeof rec["state"] === "string" ? rec["state"] : "",
      body: typeof rec["body"] === "string" ? rec["body"] : "",
    };
  });
}

function commentOf(event: KeelEvent): ThreadComment {
  const p = event.payload;
  return {
    author: event.actor ?? null,
    path: typeof p["path"] === "string" ? p["path"] : "",
    inReplyTo: typeof p["inReplyTo"] === "number" ? p["inReplyTo"] : null,
    diffHunk: typeof p["diffHunk"] === "string" ? p["diffHunk"] : "",
    body: typeof p["body"] === "string" ? p["body"] : "",
  };
}

function assembleThread(pr: KeelEvent, comments: KeelEvent[]): PrThread {
  const p = pr.payload;
  return {
    number: typeof p["number"] === "number" ? p["number"] : 0,
    title: pr.title ?? "",
    body: typeof p["body"] === "string" ? p["body"] : "",
    author: pr.actor ?? null,
    state: typeof p["state"] === "string" ? p["state"] : "",
    merged: p["merged"] === true,
    files: pr.files ?? [],
    reviews: reviewsOf(pr),
    comments: comments
      .map(commentOf)
      .sort((a, b) => (a.inReplyTo ?? 0) - (b.inReplyTo ?? 0)),
  };
}

function decisionEvent(pr: KeelEvent, thread: PrThread, record: ReturnType<typeof parseDecision>): KeelEvent {
  // Only called after confirming record is a real decision.
  const d = record as Exclude<ReturnType<typeof parseDecision>, { error: string }>;
  return {
    kind: "decision",
    externalId: `decision:${pr.externalId}`,
    occurredAt: pr.occurredAt,
    ...(pr.actor ? { actor: pr.actor } : {}),
    title: d.summary,
    payload: {
      origin: "mined",
      sourcePr: pr.externalId,
      prNumber: thread.number,
      summary: d.summary,
      rationale: d.rationale,
      alternatives: d.alternatives,
      confidence: d.confidence,
      // Grounded links are the PR's real files; the model's list is advisory.
      mentionedFiles: d.files,
      prUrl: typeof pr.payload["url"] === "string" ? pr.payload["url"] : null,
    },
    // Link the decision to the code it concerns (real files → graph nodes).
    ...(thread.files.length > 0 ? { files: thread.files } : {}),
  };
}

export async function mineDecisions(
  store: SqliteEventStore,
  model: DecisionModel,
  options: MineOptions = {},
): Promise<MineResult> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const prs = await store.byKind("pr", 100_000);
  const comments = await store.byKind("review_comment", 100_000);

  const commentsByPr = new Map<number, KeelEvent[]>();
  for (const comment of comments) {
    const n = comment.payload["prNumber"];
    if (typeof n === "number") {
      const list = commentsByPr.get(n);
      if (list) list.push(comment);
      else commentsByPr.set(n, [comment]);
    }
  }

  // Two skip signals, both avoiding a model call: a decision already exists for the PR
  // (decisions are immutable — never re-mine), or the PR was mined at its current updated_at.
  const decided = new Set(
    (await store.byKind("decision", 100_000))
      .map((d) => d.payload["sourcePr"])
      .filter((id): id is string => typeof id === "string"),
  );
  const mined = store.minedPrs();

  const pending = prs.filter((pr) => {
    if (pr.externalId === undefined || decided.has(pr.externalId)) return false;
    const seenAt = mined.get(pr.externalId);
    return seenAt === undefined || seenAt < prUpdatedAt(pr); // unmined, or changed since mined
  });
  // Newest-updated first, so the per-run cap keeps the freshest decisions.
  pending.sort((a, b) => prUpdatedAt(b).localeCompare(prUpdatedAt(a)));
  const toMine = pending.slice(0, Math.max(0, limit));

  // Announce the plan before the first model call, so a cost guard can warn (CLAUDE.md cost rules).
  options.onPlan?.(toMine.length);

  const events: KeelEvent[] = [];
  let minedCount = 0;
  let noDecision = 0;
  let errors = 0;

  for (const pr of toMine) {
    const thread = assembleThread(pr, commentsByPr.get(pr.payload["number"] as number) ?? []);

    let output: string;
    try {
      output = await model.complete(buildDecisionPrompt(thread));
    } catch (err) {
      errors++;
      if (err instanceof MinerModelError) log(`PR #${thread.number}: model error: ${err.message}`);
      else throw err;
      continue; // not marked mined — retried next run
    }

    const parsed = parseDecision(output);
    if ("error" in parsed) {
      errors++;
      log(`PR #${thread.number}: could not parse model output (${parsed.error})`);
      continue; // not marked mined — retried next run
    }

    // Mined successfully (decision or not): mark it so an unchanged PR isn't re-mined.
    store.markPrMined(pr.externalId!, prUpdatedAt(pr));
    if (!parsed.hasDecision) {
      noDecision++;
      continue;
    }
    events.push(decisionEvent(pr, thread, parsed));
    minedCount++;
  }

  const inserted = store.appendMany(events);
  return {
    model: model.name,
    total: prs.length,
    mined: inserted,
    skipped: prs.length - pending.length,
    deferred: pending.length - toMine.length,
    noDecision,
    errors,
  };
}

// Re-exported so the CLI and tests share one EventStore type import surface.
export type { EventStore };
