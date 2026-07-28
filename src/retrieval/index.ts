/**
 * The decision index: retrieve decision records by graph node or by meaning. This is the
 * read side of team memory — pure lookups over the event log and the cached graph, no model
 * calls (embeddings are computed offline; here we only compare vectors). The `why` MCP tool
 * composes these next.
 */
import type { FileGraph } from "../graph/dependencies.js";
import type { EventKind, KeelEvent } from "../events/store.js";
import type { SqliteEventStore } from "../events/sqlite-store.js";
import { cosineSimilarity, type EmbeddingModel } from "./embed.js";

const DECISION: EventKind = "decision";

/** How a decision reaches a queried file through the graph. */
export type LinkReason = "direct" | "dependency" | "dependent";

export interface LinkedDecision {
  decision: KeelEvent;
  /** why this decision is relevant to the queried file */
  reason: LinkReason;
  /** the graph node that carried the link (the file itself for "direct") */
  via: string;
  /** hops from the queried file: 0 for direct, 1 for a neighbor */
  distance: number;
}

// Strongest link wins when a decision is reachable multiple ways.
const REASON_RANK: Record<LinkReason, number> = { direct: 0, dependency: 1, dependent: 1 };

/**
 * Decisions relevant to a file: those linked directly to it, plus those about its direct
 * graph neighbors — the files it imports (dependencies) and the files that import it
 * (dependents). Neighbors are where a decision "spills over": changing a file is shaped by
 * decisions about what it builds on and what builds on it. Deduped to the strongest link.
 */
export async function decisionsForFile(
  store: SqliteEventStore,
  graph: FileGraph,
  file: string,
): Promise<LinkedDecision[]> {
  const dependencies = graph.imports.get(file) ?? new Set<string>();
  const dependents = graph.importedBy.get(file) ?? new Set<string>();

  // node -> how it links back to the queried file
  const nodes: { node: string; reason: LinkReason; distance: number }[] = [{ node: file, reason: "direct", distance: 0 }];
  for (const dep of dependencies) nodes.push({ node: dep, reason: "dependency", distance: 1 });
  for (const dep of dependents) nodes.push({ node: dep, reason: "dependent", distance: 1 });

  // decision externalId -> best link found
  const best = new Map<string, LinkedDecision>();
  for (const { node, reason, distance } of nodes) {
    for (const event of await store.byFile(node, 200)) {
      if (event.kind !== DECISION || event.externalId === undefined) continue;
      const candidate: LinkedDecision = { decision: event, reason, via: node, distance };
      const existing = best.get(event.externalId);
      if (!existing || isStrongerLink(candidate, existing)) best.set(event.externalId, candidate);
    }
  }

  return [...best.values()].sort(
    (a, b) => a.distance - b.distance || REASON_RANK[a.reason] - REASON_RANK[b.reason] || recency(b.decision, a.decision),
  );
}

function isStrongerLink(a: LinkedDecision, b: LinkedDecision): boolean {
  if (a.distance !== b.distance) return a.distance < b.distance;
  return REASON_RANK[a.reason] < REASON_RANK[b.reason];
}

function recency(a: KeelEvent, b: KeelEvent): number {
  return a.occurredAt.localeCompare(b.occurredAt);
}

export interface ScoredDecision {
  decision: KeelEvent;
  /** cosine similarity of the decision to the query, in [-1, 1] */
  score: number;
}

/**
 * Semantic search over decision records: embed the query with the same local model, then
 * rank embedded decisions by cosine similarity. Decisions without an embedding (mining ran
 * but embedding didn't) are simply not searchable — retrieval-by-file still finds them.
 */
export async function searchDecisions(
  store: SqliteEventStore,
  model: EmbeddingModel,
  query: string,
  k = 5,
): Promise<ScoredDecision[]> {
  const embeddings = store.embeddingsByKind(DECISION);
  if (embeddings.size === 0) return [];

  const [queryVector] = await model.embed([query]);
  if (!queryVector) return [];

  const decisions = await store.byKind(DECISION, 100_000);
  const scored: ScoredDecision[] = [];
  for (const decision of decisions) {
    if (decision.externalId === undefined) continue;
    const vector = embeddings.get(decision.externalId);
    if (vector) scored.push({ decision, score: cosineSimilarity(queryVector, vector) });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, k));
}
