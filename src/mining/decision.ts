/**
 * Decision records and the eval metric. A decision record is the structured "why" the
 * miner extracts from a PR thread: what was decided, the reasoning, and alternatives
 * considered. Parsing and scoring are deterministic and dependency-free so the eval
 * fixtures run without a model (see test/mining.test.ts).
 */

export type Confidence = "high" | "medium" | "low";

export interface DecisionRecord {
  /** false when the PR carries no notable decision (trivial change) — the miner skips it */
  hasDecision: boolean;
  /** one line: what was decided */
  summary: string;
  /** why it was decided this way */
  rationale: string;
  /** options considered and rejected */
  alternatives: string[];
  /** files the model says the decision concerns (advisory; grounding uses the thread's real files) */
  files: string[];
  confidence: Confidence;
}

const CONFIDENCE: readonly Confidence[] = ["high", "medium", "low"];

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
}

/**
 * Parse a model's output into a DecisionRecord. Tolerates a JSON object wrapped in prose or
 * ```json fences by extracting the first balanced object. Missing/invalid fields are
 * coerced to safe defaults; returns { error } only when no JSON object can be found.
 */
export function parseDecision(output: string): DecisionRecord | { error: string } {
  const json = extractJsonObject(output);
  if (json === null) return { error: "no JSON object in model output" };

  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (err) {
    return { error: `invalid JSON: ${(err as Error).message}` };
  }
  if (typeof data !== "object" || data === null) return { error: "model output is not an object" };
  const d = data as Record<string, unknown>;

  const summary = typeof d["summary"] === "string" ? d["summary"].trim() : "";
  // hasDecision defaults to whether a summary was produced, unless the model said otherwise.
  const hasDecision = typeof d["hasDecision"] === "boolean" ? d["hasDecision"] : summary !== "";
  const confidence = CONFIDENCE.includes(d["confidence"] as Confidence)
    ? (d["confidence"] as Confidence)
    : "low";

  return {
    hasDecision,
    summary,
    rationale: typeof d["rationale"] === "string" ? d["rationale"].trim() : "",
    alternatives: asStringArray(d["alternatives"]),
    files: asStringArray(d["files"]),
    confidence,
  };
}

/** Extract the first balanced {...} object from text (handles ```json fences, prose, and the
 *  <think>…</think> scratchpad reasoning models like DeepSeek-R1 emit — which can itself contain
 *  braces, so we strip it before scanning rather than grabbing JSON out of the model's reasoning). */
export function extractJsonObject(text: string): string | null {
  const cleaned = text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "");
  const start = cleaned.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }
  return null;
}

export interface DecisionScore {
  /** overall 0..1 */
  score: number;
  hasDecisionMatch: boolean;
  summaryOverlap: number;
  rationaleOverlap: number;
  filesJaccard: number;
}

/**
 * Eval metric comparing a predicted decision to a gold one. Word-overlap on summary and
 * rationale, Jaccard on files, plus a hasDecision agreement gate — enough to track whether
 * a prompt/model change moves extraction quality against the fixture set.
 */
export function scoreDecision(predicted: DecisionRecord, gold: DecisionRecord): DecisionScore {
  const hasDecisionMatch = predicted.hasDecision === gold.hasDecision;

  // When both agree there's no decision, that's a perfect score — nothing to compare.
  if (hasDecisionMatch && !gold.hasDecision) {
    return { score: 1, hasDecisionMatch, summaryOverlap: 1, rationaleOverlap: 1, filesJaccard: 1 };
  }

  const summaryOverlap = wordOverlap(predicted.summary, gold.summary);
  const rationaleOverlap = wordOverlap(predicted.rationale, gold.rationale);
  const filesJaccard = jaccard(new Set(predicted.files), new Set(gold.files));

  const content = 0.5 * summaryOverlap + 0.3 * rationaleOverlap + 0.2 * filesJaccard;
  const score = hasDecisionMatch ? content : 0; // wrong hasDecision zeroes the record
  return { score, hasDecisionMatch, summaryOverlap, rationaleOverlap, filesJaccard };
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  );
}

/** Overlap of gold's words that appear in the prediction (recall-oriented). */
function wordOverlap(predicted: string, gold: string): number {
  const goldWords = tokenize(gold);
  if (goldWords.size === 0) return predicted.trim() === "" ? 1 : 0;
  const predWords = tokenize(predicted);
  let hit = 0;
  for (const w of goldWords) if (predWords.has(w)) hit++;
  return hit / goldWords.size;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
