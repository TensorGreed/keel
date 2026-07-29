/**
 * Injection defense for decision text. Mined records and ADRs are derived from attacker-influenced
 * input (PR bodies, review comments, markdown files) and flow into a coding agent's context via the
 * `why` / `context` tools and the prompt-context hook. A hostile summary/rationale can carry control
 * characters, invisible bidi/zero-width tricks, fenced code that breaks out of a rendered wrapper, or
 * a wall of newlines hiding a fake "SYSTEM:" instruction.
 *
 * This module neutralizes that text before it is stored or emitted: strip control + invisible
 * characters, defuse fenced code, flatten to a single line (so no injected line can masquerade as a
 * new structural element), and hard-cap the length. It does NOT try to detect intent — it makes the
 * text inert and bounded, and the callers frame it explicitly as DATA, not instructions.
 */

/** Length caps for the fields we store/emit. Tight, because this is context an agent reads. */
export const DECISION_TEXT_CAPS = {
  summary: 200,
  rationale: 1000,
  alternative: 200,
  maxAlternatives: 6,
} as const;

// C0 (incl. NUL, tab, newline, CR) and C1 control ranges — replaced with a space so words don't fuse.
const CONTROL_CHARS = /[\x00-\x1F\x7F-\x9F]/g;
// Invisible / directional characters usable to hide or visually reorder text: soft hyphen, zero-width
// spaces & joiners, LRM/RLM, bidi embeddings/overrides/isolates, word joiner, line/para separators, BOM.
const INVISIBLE_CHARS = /[\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;
// Fenced-code markers (3+ backticks or tildes) — the main markdown "breakout" in a rendered context.
const CODE_FENCES = /(`{3,}|~{3,})/g;

/**
 * Make one attacker-influenced string inert and bounded: strip control + invisible characters,
 * defuse code fences, collapse all whitespace (including newlines) to single spaces, and cap the
 * length with an ellipsis. Idempotent, and safe on already-clean text (a normal rationale survives
 * readable).
 */
export function sanitizeDecisionText(input: unknown, maxLen: number): string {
  let s = typeof input === "string" ? input : String(input ?? "");
  s = s.replace(CONTROL_CHARS, " ").replace(INVISIBLE_CHARS, "").replace(CODE_FENCES, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > maxLen) s = s.slice(0, maxLen - 1).trimEnd() + "…";
  return s;
}

/** Sanitize an alternatives list: clean each item, drop empties, cap the count. */
export function sanitizeAlternatives(input: unknown, maxItems = DECISION_TEXT_CAPS.maxAlternatives): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const item of input) {
    const clean = sanitizeDecisionText(item, DECISION_TEXT_CAPS.alternative);
    if (clean !== "") out.push(clean);
    if (out.length >= maxItems) break;
  }
  return out;
}
