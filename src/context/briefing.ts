/**
 * `context(task, files?)`: a one-call briefing for a coding task. It resolves the files a task
 * is likely to touch, then composes what the caller would otherwise gather by hand — each
 * candidate's blast radius and key dependents (the graph), recent history (git), linked
 * decisions with receipts (the decision index), and covering tests + coverage gaps (test
 * selection) — plus the risks a change here would trip against keel.policy.json.
 *
 * Pure composition and ranking: NO generative calls. The only model touch is the same LOCAL
 * query embedding `why` uses to rank by meaning, under the identical degradation contract —
 * keyword fallback when no embedding model is reachable, never an error or a hang. Sizes are
 * capped (top N candidates by relevance) and every truncation is stated in `notes`.
 */
import type { CommitInfo } from "../git/history.js";
import { reportFor, type FileGraph } from "../graph/dependencies.js";
import type { RepoRef } from "../github/remote.js";
import type { KeelEvent } from "../events/store.js";
import type { SqliteEventStore } from "../events/sqlite-store.js";
import { cosineSimilarity, EmbeddingError, type EmbeddingModel } from "../retrieval/embed.js";
import { decisionsForFile, searchDecisions } from "../retrieval/index.js";
import { decisionReceipt, type WhyDecision } from "../retrieval/why.js";
import { isTestFile, selectTests } from "../simulate/select-tests.js";
import { globMatch, type Policy } from "../trust/policy.js";

export interface ContextInput {
  task: string;
  /** paths the caller already knows are involved (repo-relative) */
  files?: string[];
  /** max candidates to brief, by relevance (default 8) */
  topN?: number;
}

export interface ContextDeps {
  graph: FileGraph;
  store: SqliteEventStore;
  /** local embedding model for ranking the task by meaning; null → keyword fallback */
  embedModel: EmbeddingModel | null;
  repoRef: RepoRef | null;
  policy: Policy;
  /** recent commits for a file — injected so the composition is testable without git */
  history: (file: string) => Promise<CommitInfo[]>;
  /** paths that rank as repo risk hotspots (churn × blast radius × coverage gap) */
  hotspots: Set<string>;
}

export interface CandidateBrief {
  file: string;
  /** relevance in [0,1] and why this file surfaced */
  score: number;
  why: string;
  blastRadius: number;
  keyDependents: string[];
  recentHistory: { hash: string; date: string; author: string; subject: string }[];
  decisions: WhyDecision[];
  tests: { covering: string[]; uncovered: boolean };
}

export type RiskType = "uncovered" | "high-blast-radius" | "protected-path" | "top-hotspot";
export interface Risk {
  type: RiskType;
  file: string;
  detail: string;
}

export interface Briefing {
  task: string;
  candidates: CandidateBrief[];
  suggestedTests: string[];
  relevantDecisions: WhyDecision[];
  risks: Risk[];
  notes: string[];
}

const DEFAULT_TOP_N = 8;
const MAX_KEY_DEPENDENTS = 8;
const MAX_DECISIONS_PER_FILE = 5;
const MAX_SUGGESTED_TESTS = 20;
const MAX_RELEVANT_DECISIONS = 12;
const HISTORY_DEPTH = 5;
/** Blast radius that counts as "high" when the policy sets no cap of its own. */
const DEFAULT_HIGH_BLAST_RADIUS = 25;

/** Tokens of length > 2, lowercased — the same shape `why` uses for keyword scoring. */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
}

/** Path + export tokens for a file, the haystack a task's keywords are matched against. */
function fileTokens(graph: FileGraph, file: string): Set<string> {
  const bag = new Set(tokens(file));
  for (const exp of graph.exportsOf.get(file) ?? []) {
    if (exp !== "*" && exp !== "default") for (const t of tokens(exp)) bag.add(t);
  }
  return bag;
}

interface Seed {
  score: number;
  why: string;
}

/** Keep the strongest reason for a file when several signals point at it. */
function consider(seeds: Map<string, Seed>, file: string, score: number, why: string): void {
  const existing = seeds.get(file);
  if (!existing || score > existing.score) seeds.set(file, { score, why });
}

/** A short, single-line preview of a decision summary for the "why". */
function preview(summary: string, max = 60): string {
  const s = summary.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Rank decisions against the task — semantically if a model and embeddings are both present,
 * else by keyword. Mirrors `why`'s contract: an unreachable model degrades to keyword with a
 * note, never throwing. Returns [decision, score] for decisions that carry files in the graph.
 */
async function rankDecisions(
  deps: ContextDeps,
  task: string,
  notes: string[],
): Promise<{ decision: KeelEvent; score: number }[]> {
  const haveEmbeddings = deps.store.embeddingsByKind("decision").size > 0;
  if (deps.embedModel && haveEmbeddings) {
    try {
      const scored = await searchDecisions(deps.store, deps.embedModel, task, 50);
      return scored.map((s) => ({ decision: s.decision, score: Math.max(0, s.score) }));
    } catch (err) {
      if (!(err instanceof EmbeddingError)) throw err;
      notes.push("Semantic ranking unavailable (local embedding model unreachable); matched decisions by keyword.");
    }
  } else if (deps.embedModel && !haveEmbeddings) {
    notes.push("No decision embeddings present; matched decisions by keyword. Run `keel mine` to enable semantic ranking.");
  }
  const qt = new Set(tokens(task));
  const all = await deps.store.byKind("decision", 100_000);
  return all
    .map((d) => {
      const hay = new Set(tokens(`${d.title ?? ""} ${JSON.stringify(d.payload["summary"] ?? "")} ${JSON.stringify(d.payload["rationale"] ?? "")}`));
      let hits = 0;
      for (const t of qt) if (hay.has(t)) hits++;
      return { decision: d, score: qt.size === 0 ? 0 : hits / qt.size };
    })
    .filter((s) => s.score > 0);
}

/** Resolve and rank candidate files: provided files, keyword path/export match, and the files
 *  behind task-relevant decisions. Deduped to the strongest signal, sorted by relevance. */
async function resolveCandidates(
  deps: ContextDeps,
  input: ContextInput,
  notes: string[],
): Promise<{ ranked: { file: string; score: number; why: string }[]; suppressedProvided: string[] }> {
  const seeds = new Map<string, Seed>();
  const inGraph = new Set(deps.graph.files);

  // 1. Provided files always brief (score 1), even if the task text doesn't mention them.
  const suppressedProvided: string[] = [];
  for (const f of input.files ?? []) {
    if (inGraph.has(f)) consider(seeds, f, 1, "provided by the caller");
    else suppressedProvided.push(f);
  }

  // 2. Keyword match of the task against file paths + exported names. Test files are the
  //    *output* of a change (they land in suggestedTests), not a candidate target, so skip them.
  const qt = new Set(tokens(input.task));
  if (qt.size > 0) {
    for (const file of deps.graph.files) {
      if (isTestFile(file)) continue;
      const hay = fileTokens(deps.graph, file);
      let hits = 0;
      for (const t of qt) if (hay.has(t)) hits++;
      if (hits > 0) consider(seeds, file, (hits / qt.size) * 0.9, `path/export matches task (${hits} term${hits === 1 ? "" : "s"})`);
    }
  }

  // 3. Files behind decisions the task is about (semantic when available, else keyword).
  for (const { decision, score } of await rankDecisions(deps, input.task, notes)) {
    const summary = typeof decision.payload["summary"] === "string" ? decision.payload["summary"] : (decision.title ?? "a decision");
    for (const f of decision.files ?? []) {
      if (inGraph.has(f) && !isTestFile(f)) consider(seeds, f, Math.min(0.95, 0.5 + score * 0.45), `linked to decision: "${preview(summary)}"`);
    }
  }

  const ranked = [...seeds.entries()]
    .map(([file, s]) => ({ file, score: Number(s.score.toFixed(4)), why: s.why }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return { ranked, suppressedProvided };
}

export async function buildContext(
  input: ContextInput,
  deps: ContextDeps,
): Promise<Briefing | { error: string }> {
  const task = input.task?.trim();
  if (!task) return { error: "context needs a non-empty task description" };

  const notes: string[] = [];
  const topN = input.topN && input.topN > 0 ? input.topN : DEFAULT_TOP_N;

  const { ranked, suppressedProvided } = await resolveCandidates(deps, input, notes);
  if (suppressedProvided.length > 0) {
    notes.push(`Ignored ${suppressedProvided.length} provided path(s) not in the graph: ${suppressedProvided.join(", ")}.`);
  }
  if (ranked.length === 0) {
    notes.push("No candidate files matched the task by path, export, or decision. Provide files, or mine decisions with `keel ingest` + `keel mine`.");
    return { task, candidates: [], suggestedTests: [], relevantDecisions: [], risks: [], notes };
  }
  if (ranked.length > topN) {
    notes.push(`${ranked.length} files matched; briefing the top ${topN} by relevance (${ranked.length - topN} omitted).`);
  }
  const chosen = ranked.slice(0, topN);

  const highBlast = deps.policy.maxBlastRadius ?? DEFAULT_HIGH_BLAST_RADIUS;
  const candidates: CandidateBrief[] = [];
  const risks: Risk[] = [];
  const testUnion = new Set<string>();
  const decisionById = new Map<string, WhyDecision>();

  for (const c of chosen) {
    const report = reportFor(deps.graph, c.file);
    const selection = selectTests(deps.graph, [c.file]);
    const covering = selection.tests.map((t) => t.file);
    const uncovered = covering.length === 0 && !c.file.match(/\.(test|spec)\./);

    const linked = await decisionsForFile(deps.store, deps.graph, c.file);
    const decisions = linked
      .slice(0, MAX_DECISIONS_PER_FILE)
      .map((l) => decisionReceipt(l.decision, l.reason === "direct" ? "direct" : `${l.reason} (${l.via})`, deps.repoRef));

    const commits = (await deps.history(c.file)).slice(0, HISTORY_DEPTH);

    candidates.push({
      file: c.file,
      score: c.score,
      why: c.why,
      blastRadius: report.transitiveDependents.length,
      keyDependents: report.dependents.slice(0, MAX_KEY_DEPENDENTS),
      recentHistory: commits.map((k) => ({ hash: k.hash.slice(0, 9), date: k.date, author: k.author, subject: k.subject })),
      decisions,
      tests: { covering, uncovered },
    });

    for (const t of covering) testUnion.add(t);
    for (const d of decisions) if (d.id && !decisionById.has(d.id)) decisionById.set(d.id, d);

    // --- risks for this candidate ---
    if (uncovered) risks.push({ type: "uncovered", file: c.file, detail: "no test imports this file — a change here runs unverified" });
    if (report.transitiveDependents.length >= highBlast) {
      risks.push({
        type: "high-blast-radius",
        file: c.file,
        detail: `blast radius ${report.transitiveDependents.length} ≥ ${highBlast} (${deps.policy.maxBlastRadius !== null ? "policy maxBlastRadius" : "default threshold"})`,
      });
    }
    for (const p of deps.policy.protectedPaths) {
      if (globMatch(p.glob, c.file)) risks.push({ type: "protected-path", file: c.file, detail: `matches protected "${p.glob}" (${p.reason})` });
    }
    if (deps.hotspots.has(c.file)) {
      risks.push({ type: "top-hotspot", file: c.file, detail: "ranks among the repo's risk hotspots (recent churn × blast radius × coverage gap)" });
    }
    if (linked.length > MAX_DECISIONS_PER_FILE) {
      notes.push(`${c.file}: ${linked.length} linked decisions; showing the ${MAX_DECISIONS_PER_FILE} nearest.`);
    }
  }

  const suggestedTests = [...testUnion].sort();
  if (suggestedTests.length > MAX_SUGGESTED_TESTS) {
    notes.push(`${suggestedTests.length} covering tests across candidates; listing the first ${MAX_SUGGESTED_TESTS}.`);
  }

  const relevantDecisions = [...decisionById.values()]
    .sort((a, b) => (a.origin === "human" ? 0 : 1) - (b.origin === "human" ? 0 : 1) || (b.source.date ?? "").localeCompare(a.source.date ?? ""));
  if (relevantDecisions.length > MAX_RELEVANT_DECISIONS) {
    notes.push(`${relevantDecisions.length} relevant decisions; listing the top ${MAX_RELEVANT_DECISIONS} (human-recorded first).`);
  }

  if (deps.embedModel === null) {
    notes.push("Ranked by keyword (no local embedding model configured). Semantic ranking would refine relevance.");
  }

  return {
    task,
    candidates,
    suggestedTests: suggestedTests.slice(0, MAX_SUGGESTED_TESTS),
    relevantDecisions: relevantDecisions.slice(0, MAX_RELEVANT_DECISIONS),
    risks,
    notes,
  };
}
