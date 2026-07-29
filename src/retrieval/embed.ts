/**
 * Embeddings for decision retrieval. Computed offline by a LOCAL model — the only model
 * calls keel makes are in the mining/embedding pipeline, never the MCP server (CLAUDE.md).
 * EmbeddingModel is the injectable seam; tests use a fake and never touch the network.
 */
import type { EventKind, KeelEvent } from "../events/store.js";
import type { SqliteEventStore } from "../events/sqlite-store.js";
import { fetchTimed, ollamaEmbedTimeoutMs } from "../util/timeouts.js";

export interface EmbeddingModel {
  /** Embed a batch of texts into unit-comparable vectors. Throws EmbeddingError on failure. */
  embed(texts: string[]): Promise<Float32Array[]>;
  readonly name: string;
}

export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingError";
  }
}

const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_EMBED_MODEL = "nomic-embed-text";
const BATCH_SIZE = 32;

/** Local embeddings via Ollama's /api/embed (batched input). */
export class OllamaEmbeddingModel implements EmbeddingModel {
  readonly name: string;

  constructor(
    private readonly model: string = DEFAULT_EMBED_MODEL,
    private readonly baseUrl: string = DEFAULT_OLLAMA_URL,
    /** cap so an unreachable/slow Ollama can't hang the caller (query-time: see why.ts; offline
     *  mining: see mining/decision-cli.ts) — defaults to KEEL_OLLAMA_EMBED_TIMEOUT / 20s. */
    private readonly timeoutMs: number = ollamaEmbedTimeoutMs(),
  ) {
    this.name = `ollama:${model}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    let res: Response;
    try {
      res = await fetchTimed(
        `${this.baseUrl.replace(/\/$/, "")}/api/embed`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: this.model, input: texts }),
        },
        this.timeoutMs,
        `Ollama embed (${this.model})`,
      );
    } catch (err) {
      const e = err as Error;
      if (e.name === "TimeoutError" || e.name === "AbortError") {
        throw new EmbeddingError(`Ollama at ${this.baseUrl} timed out after ${Math.round(this.timeoutMs / 1000)}s (raise KEEL_OLLAMA_EMBED_TIMEOUT to allow longer)`);
      }
      throw new EmbeddingError(`cannot reach Ollama at ${this.baseUrl}: ${e.message}`);
    }
    if (!res.ok) {
      throw new EmbeddingError(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = (await res.json()) as { embeddings?: number[][] };
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
      throw new EmbeddingError("Ollama returned an unexpected embeddings shape");
    }
    return data.embeddings.map((v) => Float32Array.from(v));
  }
}

/** Cosine similarity in [-1, 1]; 0 if either vector is empty or zero-length. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** The text a decision is embedded from: what was decided, why, and the alternatives. */
export function decisionText(decision: KeelEvent): string {
  const p = decision.payload;
  const parts = [decision.title ?? ""];
  if (typeof p["rationale"] === "string" && p["rationale"].trim() !== "") parts.push(p["rationale"]);
  const alts = p["alternatives"];
  if (Array.isArray(alts) && alts.length > 0) parts.push(`Alternatives: ${alts.join("; ")}`);
  return parts.join("\n");
}

export interface EmbedResult {
  model: string;
  /** decisions examined */
  total: number;
  /** decisions newly embedded this run */
  embedded: number;
  /** decisions skipped because they were already embedded */
  skipped: number;
  error?: string;
}

const DECISION: EventKind = "decision";

/**
 * Embed decision records that don't yet have an embedding. Idempotent — a re-run only
 * embeds new decisions. On a model failure it stores what it computed so far and returns
 * the error as data (never throws), so a partial run is safe and resumable.
 */
export async function embedDecisions(store: SqliteEventStore, model: EmbeddingModel): Promise<EmbedResult> {
  const decisions = await store.byKind(DECISION, 100_000);
  const already = store.embeddingsByKind(DECISION);
  const pending = decisions.filter((d) => d.externalId !== undefined && !already.has(d.externalId));

  let embedded = 0;
  let error: string | undefined;
  for (let i = 0; i < pending.length && error === undefined; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    let vectors: Float32Array[];
    try {
      vectors = await model.embed(batch.map(decisionText));
    } catch (err) {
      if (!(err instanceof EmbeddingError)) throw err;
      error = err.message;
      break;
    }
    // One transaction per batch: a kill mid-run leaves whole committed batches, never a torn one.
    const toStore: { kind: EventKind; externalId: string; vector: Float32Array }[] = [];
    batch.forEach((decision, j) => {
      const vector = vectors[j];
      if (vector) toStore.push({ kind: DECISION, externalId: decision.externalId!, vector });
    });
    store.setEmbeddings(toStore);
    embedded += toStore.length;
  }

  return {
    model: model.name,
    total: decisions.length,
    embedded,
    skipped: decisions.length - pending.length,
    ...(error ? { error } : {}),
  };
}
