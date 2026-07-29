/**
 * `keel prompt-context` core — surface recorded decisions that relate to a user's prompt, for
 * Claude Code's UserPromptSubmit hook. Field finding: even with tool descriptions and CLAUDE.md
 * guidance in place, agents answer code questions by reading code and never call `why`. This
 * pushes the memory to them: a fast match of the prompt against the decision index, injected as
 * `additionalContext` when (and only when) something relevant exists.
 *
 * Budget is the whole design. This runs on EVERY prompt, so it must be fast and silent when it
 * has nothing: a synchronous keyword pass over summaries/rationales, plus a best-effort local
 * embedding ranking that is raced against a hard cap and simply dropped if Ollama is slow or
 * unreachable (CLAUDE.md principle 1 — the one query-time model call must degrade to a fallback,
 * never an error or a hang). No hits → empty output. Never throws across the hook boundary.
 *
 * Precision over recall is the whole point: silence is the correct output for most prompts. A
 * match must clear a real relevance bar — a *distinctive* keyword overlap (function words and
 * generic repo/dev vocabulary don't count) or a minimum cosine — and a prompt with no distinctive
 * terms at all ("list the directories in this repo") is dropped before any store read or embedding.
 * We emit only what clears the bar (0–3), and never pad to a fixed count.
 */
import type { KeelEvent } from "../events/store.js";
import { cosineSimilarity, decisionText, type EmbeddingModel } from "./embed.js";

/** Structural slice of the event store this needs — lets tests use a fake without SQLite. */
export interface DecisionSource {
  byKind(kind: "decision", limit?: number): Promise<KeelEvent[]>;
  embeddingsByKind(kind: "decision"): Map<string, Float32Array>;
  suppressedDecisions(): Set<string>;
}

export interface PromptMatch {
  id: string;
  summary: string;
  /** PR URL / ADR path / `PR #N` — a receipt to follow, or null if the record has none */
  receipt: string | null;
  files: string[];
  /** best of the keyword / semantic scores, for ranking (not shown) */
  score: number;
}

export interface MatchOptions {
  /** local embedding model for the prompt (null → keyword-only). */
  embedModel: EmbeddingModel | null;
  /** hard wall-clock cap on the semantic step in ms; on timeout we fall back to keyword-only. */
  budgetMs?: number;
}

const TOP_N = 3;
/** Cosine floor for a semantic-only hit — below this, an embedded decision isn't "related". Set
 *  high on purpose: this is the precision knob for the embedding path. */
const SEMANTIC_HIT = 0.6;
const DEFAULT_BUDGET_MS = 1000;

// Output caps — this is injected context, so keep it tight and never unbounded.
const MAX_CONTEXT_CHARS = 1200;
const MAX_SUMMARY_CHARS = 160;
const MAX_FILES = 3;

/**
 * Function words + generic repo/dev vocabulary that carry no topical signal on their own. A prompt
 * built only from these ("list the directories in this repo") is not a targeted question, and a
 * keyword overlap on one of them is not evidence of relevance — so they're excluded both when
 * deciding whether a prompt is distinctive enough to look up and when scoring an overlap. Words of
 * length ≤ 2 are already dropped by tokens(), so this only needs the longer ones.
 */
const IGNORED_TERMS = new Set<string>([
  // English function / filler words
  "the", "and", "for", "are", "was", "were", "been", "being", "this", "that", "these", "those",
  "its", "you", "your", "our", "their", "they", "them", "his", "her", "she", "who", "whom", "whose",
  "how", "what", "why", "when", "where", "which", "can", "could", "should", "would", "will", "shall",
  "may", "might", "must", "not", "but", "with", "from", "into", "onto", "over", "out", "off",
  "about", "just", "then", "than", "because", "have", "has", "had", "does", "did", "done", "doing",
  "please", "let", "lets", "need", "want", "get", "gets", "got", "make", "makes", "made", "use",
  "uses", "using", "help", "here", "there", "some", "any", "all", "one", "two", "new", "old", "via",
  "per", "yes",
  // Generic repo / dev vocabulary — true of almost any codebase, so no signal
  "file", "files", "repo", "repos", "repository", "directory", "directories", "folder", "folders",
  "code", "codebase", "sample", "samples", "example", "examples", "run", "running", "runs", "list",
  "lists", "show", "shows", "print", "prints", "test", "tests", "function", "functions", "method",
  "methods", "class", "classes", "project", "projects", "app", "apps", "application", "module",
  "modules", "change", "changes", "update", "updates", "fix", "fixes", "work", "works", "thing",
  "things", "stuff", "add", "adds", "added", "remove", "removes", "create", "creates", "name",
  "names", "line", "lines", "path", "paths",
]);

/** Tokens of length > 2, lowercased (shared shape with the `why` keyword fallback). */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
}

/** Unique, lowercased tokens of a prompt that carry topical signal — length > 2 and not an ignored
 *  function/generic term. The presence of ANY of these is what makes a prompt worth looking up. */
function distinctiveTokens(text: string): string[] {
  const out = new Set<string>();
  for (const w of tokens(text)) if (!IGNORED_TERMS.has(w)) out.add(w);
  return [...out];
}

/**
 * Distinctive-overlap score: the fraction of the prompt's DISTINCTIVE tokens that appear in the
 * decision's summary/rationale. A generic-word match contributes nothing, so any positive score
 * means at least one real topical term matched — the keyword relevance bar.
 */
function keywordScore(decision: KeelEvent, distinctivePromptTokens: string[]): number {
  if (distinctivePromptTokens.length === 0) return 0;
  const hay = new Set(tokens(decisionText(decision)));
  let hits = 0;
  for (const w of distinctivePromptTokens) if (hay.has(w)) hits++;
  return hits / distinctivePromptTokens.length;
}

function summaryOf(d: KeelEvent): string {
  const s = d.payload["summary"];
  return typeof s === "string" && s.trim() !== "" ? s : (d.title ?? "");
}

/** The receipt to follow: explicit PR URL, else ADR path, else a bare `PR #N`, else nothing. */
function receiptOf(d: KeelEvent): string | null {
  const p = d.payload;
  if (typeof p["prUrl"] === "string" && p["prUrl"] !== "") return p["prUrl"];
  if (typeof p["adrPath"] === "string" && p["adrPath"] !== "") return p["adrPath"];
  return typeof p["prNumber"] === "number" ? `PR #${p["prNumber"]}` : null;
}

/** Race a promise against a cap, resolving to `fallback` on timeout OR rejection — never throws. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    if (typeof timer.unref === "function") timer.unref(); // don't keep the process alive for the cap
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/**
 * Cosine-rank the embedded decisions against the prompt. Returns null (→ keyword-only) when
 * nothing is embedded or the local model is unreachable/slow — that's the graceful degradation,
 * not an error.
 */
async function semanticScores(
  store: DecisionSource,
  model: EmbeddingModel,
  prompt: string,
  decisions: KeelEvent[],
): Promise<Map<string, number> | null> {
  const embeddings = store.embeddingsByKind("decision");
  if (embeddings.size === 0) return null;
  let queryVec: Float32Array | undefined;
  try {
    [queryVec] = await model.embed([prompt]);
  } catch {
    return null; // EmbeddingError (timeout/unreachable) → keyword-only, silent
  }
  if (!queryVec) return null;
  const scores = new Map<string, number>();
  for (const d of decisions) {
    const vec = d.externalId !== undefined ? embeddings.get(d.externalId) : undefined;
    if (vec && vec.length === queryVec.length) scores.set(d.externalId!, cosineSimilarity(queryVec, vec));
  }
  return scores;
}

/**
 * Match a prompt to the recorded decisions that clear a relevance bar (0–3, never padded). A
 * decision is a hit if the prompt shares a DISTINCTIVE word with its summary/rationale, OR (when
 * embeddings are available and answer in time) it is semantically close above a cosine floor.
 * Suppressed (rejected) decisions are excluded. Never throws.
 */
export async function matchPromptDecisions(
  store: DecisionSource,
  prompt: string,
  opts: MatchOptions,
): Promise<PromptMatch[]> {
  // Relevance gate, before any work: a prompt with no distinctive terms — only function words and
  // generic repo/dev vocabulary — is not a targeted question. Skip it entirely (no store read, no
  // embedding). Silence is the right answer, and it's the cheapest one.
  const distinct = distinctiveTokens(prompt);
  if (distinct.length === 0) return [];

  let decisions: KeelEvent[];
  try {
    const suppressed = store.suppressedDecisions();
    decisions = (await store.byKind("decision", 100_000)).filter(
      (d) => d.externalId !== undefined && !suppressed.has(d.externalId),
    );
  } catch {
    return []; // a store hiccup must not surface as a hook error
  }
  if (decisions.length === 0) return [];

  // Keyword pass: synchronous and instant — the reliable signal, and the one that works with
  // zero embeddings. A positive score means at least one distinctive term overlapped.
  const kwById = new Map<string, number>();
  for (const d of decisions) kwById.set(d.externalId!, keywordScore(d, distinct));

  // Semantic pass: best-effort, raced against the hard budget. Any slowness → keyword-only.
  const semById = opts.embedModel
    ? await withTimeout(
        semanticScores(store, opts.embedModel, prompt, decisions),
        opts.budgetMs ?? DEFAULT_BUDGET_MS,
        null,
      )
    : null;

  return decisions
    .map((d) => {
      const kw = kwById.get(d.externalId!) ?? 0;
      const sem = semById?.get(d.externalId!) ?? 0;
      return { d, kw, sem, score: Math.max(kw, sem) };
    })
    .filter((x) => x.kw > 0 || x.sem >= SEMANTIC_HIT)
    .sort((a, b) => b.score - a.score || b.d.occurredAt.localeCompare(a.d.occurredAt))
    .slice(0, TOP_N)
    .map((x) => ({
      id: x.d.externalId!,
      summary: summaryOf(x.d),
      receipt: receiptOf(x.d),
      files: x.d.files ?? [],
      score: x.score,
    }));
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}

/**
 * Render the matches as the hook's `additionalContext` string — one compact line each (summary,
 * receipt, linked files), under a header that names the `why` tool and the reason it exists.
 * Empty when there are no matches; hard-capped in length.
 */
export function renderAdditionalContext(matches: PromptMatch[]): string {
  if (matches.length === 0) return "";
  const lines = matches.map((m) => {
    const receipt = m.receipt ? ` — ${m.receipt}` : "";
    const shown = m.files.slice(0, MAX_FILES).join(", ");
    const more = m.files.length > MAX_FILES ? ", …" : "";
    const files = m.files.length > 0 ? ` (files: ${shown}${more})` : "";
    return `- ${truncate(m.summary, MAX_SUMMARY_CHARS)}${receipt}${files}`;
  });
  const header =
    "Keel decision memory — recorded decision(s) that may relate to this request. " +
    "Call the `why` tool for the full rationale and receipts BEFORE removing, reverting, or simplifying any of the behavior below:";
  return truncate([header, ...lines].join("\n"), MAX_CONTEXT_CHARS);
}

/**
 * Parse a Claude Code UserPromptSubmit hook payload and pull out the prompt text. Returns null on
 * anything malformed or promptless — the caller stays silent rather than erroring.
 */
export function parseHookPrompt(raw: string): string | null {
  if (raw.trim() === "") return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const prompt = (data as { prompt?: unknown }).prompt;
  return typeof prompt === "string" && prompt.trim() !== "" ? prompt : null;
}

/** The UserPromptSubmit hook control JSON: inject `additionalContext` for the model to read. */
export function buildHookOutput(additionalContext: string): string {
  return (
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext },
    }) + "\n"
  );
}
