/**
 * The scanner registry: which languages the graph understands. Adding a language is adding a
 * scanner here — the composer (dependencies.ts) wires them by file extension and needs no other
 * change. Today: TypeScript/JavaScript. (Python lands in the next commit.)
 */
import type { LanguageScanner } from "./scanner.js";
import { createTypeScriptScanner, TS_EXTENSIONS } from "./typescript-scanner.js";

/** Every extension any scanner owns — the set the composer treats as graph source files. */
export const GRAPH_EXTENSIONS: ReadonlySet<string> = new Set([...TS_EXTENSIONS]);

/** Fresh scanner instances for a repo (each may hold per-repo resolution state). */
export function createScanners(root: string): LanguageScanner[] {
  return [createTypeScriptScanner(root)];
}
