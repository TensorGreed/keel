/**
 * `why(path?, question?)`: answer "why is this like this?" from mined + human decision
 * records, with source receipts. Composes graph-node linkage (decisionsForFile) and
 * semantic search (searchDecisions) over the decision index.
 *
 * Degrades gracefully by contract: the only server-side model call is a LOCAL query
 * embedding (CLAUDE.md principle 1). When that's unreachable — or nothing is embedded — it
 * falls back to case-insensitive keyword match and says so; never an error, never a hang.
 * Human ("pin/correct") decisions always outrank mined ones; suppressed ones are excluded.
 */
import type { KeelEvent } from "../events/store.js";
import type { SqliteEventStore } from "../events/sqlite-store.js";
import type { FileGraph } from "../graph/dependencies.js";
import type { RepoRef } from "../github/remote.js";
import { cosineSimilarity, decisionText, EmbeddingError, type EmbeddingModel } from "./embed.js";
import { decisionsForFile, searchDecisions } from "./index.js";

export type DecisionOrigin = "mined" | "human";

export interface WhySource {
  pr: number | null;
  url: string | null;
  author: string | null;
  date: string | null;
}

export interface WhyDecision {
  id: string;
  summary: string;
  rationale: string;
  alternatives: string[];
  confidence: string;
  origin: DecisionOrigin;
  /** why this surfaced: direct/dependency (node)/dependent (node)/semantic/keyword */
  matchReason: string;
  source: WhySource;
  files: string[];
}

export interface WhyResult {
  decisions: WhyDecision[];
  searched: { byFile: boolean; semantic: boolean };
  notes: string[];
}

export interface WhyDeps {
  graph: FileGraph | null;
  /** local embedding model for the query (null → keyword fallback) */
  embedModel: EmbeddingModel | null;
  /** owner/repo for constructing PR URLs when a decision lacks one */
  repoRef: RepoRef | null;
}

interface Candidate {
  decision: KeelEvent;
  reason: string;
  score: number;
}

function originOf(decision: KeelEvent): DecisionOrigin {
  return decision.payload["origin"] === "human" ? "human" : "mined";
}

/** Tokens of length > 2, lowercased. */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
}

/** How many of the query's words appear in the decision's summary/rationale (keyword score). */
function keywordScore(decision: KeelEvent, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const hay = new Set(tokens(decisionText(decision)));
  let hits = 0;
  for (const w of queryTokens) if (hay.has(w)) hits++;
  return hits / queryTokens.length;
}

export async function answerWhy(
  store: SqliteEventStore,
  input: { path?: string; question?: string },
  deps: WhyDeps,
): Promise<WhyResult | { error: string }> {
  const path = input.path?.trim() || undefined;
  const question = input.question?.trim() || undefined;
  if (!path && !question) return { error: "provide a path, a question, or both" };

  const notes: string[] = [];
  const searched = { byFile: false, semantic: false };
  const suppressed = store.suppressedDecisions();
  let candidates: Candidate[] = [];

  // --- file linkage ---
  if (path) {
    searched.byFile = true;
    if (!deps.graph) {
      notes.push(`No graph available for "${path}" (not a git repo, or the file is outside the graph); skipping file links.`);
    } else {
      const linked = await decisionsForFile(store, deps.graph, path);
      candidates = linked.map((l) => ({
        decision: l.decision,
        reason: l.reason === "direct" ? "direct" : `${l.reason} (${l.via})`,
        score: 0,
      }));
    }
  }

  // --- question ranking / search ---
  if (question) {
    if (path) {
      // filter-then-rank: keep the file-linked set, rank it by the question.
      const scores = await scoreByQuestion(store, candidates.map((c) => c.decision), question, deps, notes, searched);
      candidates = candidates.map((c) => ({ ...c, score: scores.get(c.decision.externalId ?? "") ?? 0 }));
    } else {
      candidates = await searchOrKeyword(store, question, deps, notes, searched);
    }
  }

  // --- suppress, dedupe, rank (human first) ---
  const seen = new Set<string>();
  const kept: Candidate[] = [];
  for (const c of candidates) {
    const id = c.decision.externalId;
    if (id === undefined || suppressed.has(id) || seen.has(id)) continue;
    seen.add(id);
    kept.push(c);
  }
  kept.sort(
    (a, b) =>
      originRank(a.decision) - originRank(b.decision) ||
      b.score - a.score ||
      b.decision.occurredAt.localeCompare(a.decision.occurredAt),
  );

  const decisions = kept.map((c) => toWhyDecision(c, deps.repoRef));
  if (decisions.some((d) => d.source.url === null)) {
    notes.push("Some decisions have no resolvable PR link (human-added, or the repo/PR could not be determined).");
  }
  if (decisions.length === 0) notes.push(...emptinessNotes(store, { path, question }));

  return { decisions, searched, notes };
}

function originRank(decision: KeelEvent): number {
  return originOf(decision) === "human" ? 0 : 1; // human overrides win
}

/** Score a fixed candidate set by the question — semantic if possible, else keyword. */
async function scoreByQuestion(
  store: SqliteEventStore,
  decisions: KeelEvent[],
  question: string,
  deps: WhyDeps,
  notes: string[],
  searched: { semantic: boolean },
): Promise<Map<string, number>> {
  const embeddings = store.embeddingsByKind("decision");
  if (deps.embedModel && embeddings.size > 0) {
    try {
      const [queryVector] = await deps.embedModel.embed([question]);
      if (queryVector) {
        searched.semantic = true;
        const scores = new Map<string, number>();
        for (const d of decisions) {
          const vec = d.externalId ? embeddings.get(d.externalId) : undefined;
          scores.set(d.externalId ?? "", vec ? cosineSimilarity(queryVector, vec) : 0);
        }
        return scores;
      }
    } catch (err) {
      if (!(err instanceof EmbeddingError)) throw err;
      notes.push("Semantic ranking unavailable (local embedding model unreachable); ranked by keyword.");
    }
  }
  const qt = tokens(question);
  return new Map(decisions.map((d) => [d.externalId ?? "", keywordScore(d, qt)]));
}

/** Question-only path: semantic search over all decisions, else keyword; human decisions unioned in. */
async function searchOrKeyword(
  store: SqliteEventStore,
  question: string,
  deps: WhyDeps,
  notes: string[],
  searched: { semantic: boolean },
): Promise<Candidate[]> {
  const allDecisions = await store.byKind("decision", 100_000);
  const qt = tokens(question);

  let candidates: Candidate[] | null = null;
  if (deps.embedModel && store.embeddingsByKind("decision").size > 0) {
    try {
      const results = await searchDecisions(store, deps.embedModel, question, 50);
      searched.semantic = true;
      candidates = results.map((r) => ({ decision: r.decision, reason: "semantic", score: r.score }));
    } catch (err) {
      if (!(err instanceof EmbeddingError)) throw err;
      notes.push("Semantic search unavailable (local embedding model unreachable); used keyword match.");
    }
  }
  if (candidates === null) {
    if (searched.semantic === false && store.embeddingsByKind("decision").size === 0) {
      notes.push("Semantic search unavailable (no embeddings); used keyword match. Run `keel mine` to enable it.");
    }
    candidates = allDecisions
      .map((d) => ({ decision: d, reason: "keyword", score: keywordScore(d, qt) }))
      .filter((c) => c.score > 0);
  }

  // Guarantee human decisions surface even if unembedded: union any human keyword matches.
  const present = new Set(candidates.map((c) => c.decision.externalId));
  for (const d of allDecisions) {
    if (originOf(d) === "human" && !present.has(d.externalId) && keywordScore(d, qt) > 0) {
      candidates.push({ decision: d, reason: "keyword", score: keywordScore(d, qt) });
    }
  }
  return candidates;
}

function toWhyDecision(c: Candidate, repoRef: RepoRef | null): WhyDecision {
  return decisionReceipt(c.decision, c.reason, repoRef);
}

/**
 * Turn a decision event into a receipt-bearing record: summary/rationale/alternatives, its
 * origin, why it matched, and its source (PR number/URL/author/date — URL from the ingested
 * link, else reconstructed from owner/repo + number). Shared by `why` and the trust layer.
 */
export function decisionReceipt(decision: KeelEvent, matchReason: string, repoRef: RepoRef | null): WhyDecision {
  const p = decision.payload;
  const prNumber = typeof p["prNumber"] === "number" ? p["prNumber"] : null;
  const explicitUrl = typeof p["prUrl"] === "string" ? p["prUrl"] : null;
  const url = explicitUrl ?? (repoRef && prNumber !== null ? `https://github.com/${repoRef.owner}/${repoRef.repo}/pull/${prNumber}` : null);
  return {
    id: decision.externalId ?? "",
    summary: typeof p["summary"] === "string" ? p["summary"] : (decision.title ?? ""),
    rationale: typeof p["rationale"] === "string" ? p["rationale"] : "",
    alternatives: Array.isArray(p["alternatives"]) ? (p["alternatives"] as unknown[]).filter((a): a is string => typeof a === "string") : [],
    confidence: typeof p["confidence"] === "string" ? p["confidence"] : "low",
    origin: originOf(decision),
    matchReason,
    source: {
      pr: prNumber,
      url,
      author: decision.actor ?? (typeof p["author"] === "string" ? p["author"] : null),
      date: decision.occurredAt,
    },
    files: decision.files ?? [],
  };
}

/** When nothing matched, say what exists and which command fills the gap. */
function emptinessNotes(store: SqliteEventStore, input: { path?: string; question?: string }): string[] {
  const prs = store.count("pr");
  const decisions = store.count("decision");
  const embedded = store.embeddingsByKind("decision").size;
  const notes: string[] = [];

  if (decisions === 0) {
    if (prs === 0) {
      notes.push("No decisions have been mined, and no PRs are ingested. Run `keel ingest`, then `keel mine`.");
    } else {
      notes.push(`No decisions have been mined yet (${prs} PR(s) ingested). Run \`keel mine\`.`);
    }
    return notes;
  }
  const scope = input.path ? `linked to "${input.path}"` : `matching "${input.question}"`;
  notes.push(`No decision ${scope}, though ${decisions} decision(s) exist.`);
  if (input.question && embedded === 0) {
    notes.push("No embeddings present, so only keyword matching was possible. Run `keel mine` to enable semantic search.");
  }
  return notes;
}
