/**
 * Mechanical faults, for measuring test selection.
 *
 * The harness (selection.ts) needs a *small, real* break in a source file — one a competent test
 * suite would notice — so it can ask whether keel's selection catches it. Mutation testing normally
 * asks "is this test suite any good?"; here the suite is the ORACLE and keel is what's on trial. The
 * question is never "did a test fail" but "did keel choose to run the test that failed".
 *
 * Two properties matter more than sophistication:
 *
 *   - **Syntax-safe.** Every operator here is swapped for one of the same arity and precedence, and
 *     literals for literals of the same type. A mutation that fails to parse makes the whole suite
 *     collapse, which produces a trial with no signal and wastes a full test run.
 *   - **Deterministic.** File choice and mutation site come from a seeded sequence with no clock and
 *     no randomness, so the same repo at the same commit measures the same way twice. An escape rate
 *     you can't reproduce isn't evidence.
 *
 * Deliberately textual rather than AST-based. It has to work on TypeScript, Python, Go and Java
 * without four parsers, and the mutations chosen are ones where a textual swap is unambiguous. The
 * cost is that some candidate sites are inside strings or comments; those produce a mutation the
 * suite doesn't notice, which the harness already reports separately as "the suite didn't catch it"
 * rather than counting against keel.
 */

export interface Mutation {
  /** repo-relative posix path of the file mutated */
  file: string;
  /** 1-based line the change lands on */
  line: number;
  /** what it was, and what it became — the one-line description of the injected fault */
  from: string;
  to: string;
  /** the file's full contents, mutated */
  mutated: string;
}

/**
 * Operator swaps, each to something of the same shape. Order matters: longer operators are tried
 * first so `===` is never matched as `==` with a trailing `=`.
 */
const OPERATOR_SWAPS: [string, string][] = [
  ["===", "!=="],
  ["!==", "==="],
  ["<=", ">"],
  [">=", "<"],
  ["&&", "||"],
  ["||", "&&"],
  ["==", "!="],
  ["!=", "=="],
];

/** Literal swaps — same type, different value, so the expression still typechecks. */
const LITERAL_SWAPS: [RegExp, (m: string) => string][] = [
  [/\btrue\b/, () => "false"],
  [/\bfalse\b/, () => "true"],
  [/\bNone\b/, () => "True"], // Python
  [/\bnil\b/, () => "true"], // Go — comparisons against nil are everywhere
];

/** Lines a textual mutation should never touch: imports, and anything that is obviously a comment. */
function isMutableLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "") return false;
  if (/^(\/\/|#|\*|\/\*)/.test(trimmed)) return false;
  if (/^(import|from|export\s+\*|package|use)\b/.test(trimmed)) return false;
  // A line that is only a string literal is almost certainly a message, not logic.
  if (/^["'`].*["'`],?$/.test(trimmed)) return false;
  return true;
}

/**
 * Every site in `content` a mutation could be applied at, in file order. Exposed so the harness can
 * report honestly when a file offers none — "no mutable site" is a real outcome, not a failure.
 */
export function mutationSites(content: string): { line: number; from: string; to: string; column: number }[] {
  const sites: { line: number; from: string; to: string; column: number }[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!isMutableLine(line)) continue;

    for (const [from, to] of OPERATOR_SWAPS) {
      const column = line.indexOf(from);
      if (column < 0) continue;
      // `===` contains `==`; only accept a match that isn't part of a longer operator.
      const after = line.slice(column + from.length);
      const before = line.slice(0, column);
      if (/^[=<>!&|]/.test(after) || /[=<>!&|]$/.test(before)) continue;
      sites.push({ line: i + 1, from, to, column });
      break; // one site per line keeps the fault minimal and the diff readable
    }
    if (sites.length > 0 && sites[sites.length - 1]!.line === i + 1) continue;

    for (const [pattern, replace] of LITERAL_SWAPS) {
      const match = pattern.exec(line);
      if (!match) continue;
      sites.push({ line: i + 1, from: match[0], to: replace(match[0]), column: match.index });
      break;
    }
  }
  return sites;
}

/**
 * Apply the `index`-th mutation site of `content` (wrapping), or null when the file offers none.
 * Splitting choice from application is what makes the harness reproducible: the same index always
 * yields the same fault.
 */
export function mutate(file: string, content: string, index: number): Mutation | null {
  const sites = mutationSites(content);
  if (sites.length === 0) return null;
  const site = sites[Math.abs(index) % sites.length]!;

  const lines = content.split("\n");
  const original = lines[site.line - 1]!;
  lines[site.line - 1] = original.slice(0, site.column) + site.to + original.slice(site.column + site.from.length);

  return { file, line: site.line, from: site.from, to: site.to, mutated: lines.join("\n") };
}

/**
 * A deterministic 32-bit sequence (xorshift) for choosing files and sites. Seeded explicitly rather
 * than from the clock: two runs of the harness over one commit must measure the same way, or the
 * number it produces can't be checked by anyone else.
 */
export function sequence(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}
