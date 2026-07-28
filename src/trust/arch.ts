/**
 * Architectural import rules: find graph edges a policy forbids. A rule `{ from, to }` is
 * violated by any import edge whose importer matches `from` and whose imported file matches
 * `to` (segment globs, the same matcher as protectedPaths). Pure graph analysis — no I/O, no
 * model calls.
 *
 * The verdict gates on violations whose importer is a *changed* file (introduced or retained
 * by the change); `keel report --arch` lists every repo-wide violation so a team can adopt a
 * rule on a legacy repo — changed-file edges gate, pre-existing edges inform.
 */
import type { FileGraph } from "../graph/dependencies.js";
import { globMatch, type ForbiddenImport } from "./policy.js";

export interface ArchViolation {
  /** the importing file (matches the rule's `from`) */
  from: string;
  /** the imported file (matches the rule's `to`) */
  to: string;
  rule: ForbiddenImport;
}

/** Every import edge in the graph that a forbidden-import rule matches. Deterministic order. */
export function findForbiddenEdges(graph: FileGraph, rules: ForbiddenImport[]): ArchViolation[] {
  if (rules.length === 0) return [];
  const violations: ArchViolation[] = [];
  const importers = [...graph.imports.keys()].sort();
  for (const importer of importers) {
    const imported = [...(graph.imports.get(importer) ?? [])].sort();
    for (const target of imported) {
      for (const rule of rules) {
        if (globMatch(rule.from, importer) && globMatch(rule.to, target)) {
          violations.push({ from: importer, to: target, rule });
        }
      }
    }
  }
  return violations;
}

/**
 * The subset of violations the change owns: those whose importing file is one the change
 * touched. Reading the edge from the post-change graph, a "changed importer" edge is one the
 * change introduced (new) or retained (kept) — either way the change is responsible for it.
 * Edges the change removed are absent from the graph; edges in untouched files are excluded.
 */
export function gatingViolations(all: ArchViolation[], changedFiles: Set<string>): ArchViolation[] {
  return all.filter((v) => changedFiles.has(v.from));
}

/** A one-line, stable description of a violation for a reason string or CLI line. */
export function describeViolation(v: ArchViolation): string {
  return `${v.from} → ${v.to} violates "${v.rule.from}" ⇏ "${v.rule.to}" (${v.rule.reason})`;
}
