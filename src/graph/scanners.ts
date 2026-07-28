/**
 * The scanner registry: which languages the graph understands. Adding a language is adding a
 * scanner here — the composer (dependencies.ts) wires them by file extension and needs no other
 * change. Today: TypeScript/JavaScript and Python.
 *
 * Python parses via web-tree-sitter (WASM), which needs a one-time async init before a graph
 * that may contain Python is built; `initGraphScanners()` performs it and is awaited on the
 * graph cache's load path (and by any direct buildFileGraph caller that may see Python).
 */
import type { LanguageScanner } from "./scanner.js";
import { createTypeScriptScanner, TS_EXTENSIONS } from "./typescript-scanner.js";
import { createPythonScanner, initPythonScanner, PYTHON_EXTENSIONS } from "./python-scanner.js";
import { createGoScanner, GO_EXTENSIONS, initGoScanner } from "./go-scanner.js";

/** Every extension any scanner owns — the set the composer treats as graph source files. */
export const GRAPH_EXTENSIONS: ReadonlySet<string> = new Set([...TS_EXTENSIONS, ...PYTHON_EXTENSIONS, ...GO_EXTENSIONS]);

/** Fresh scanner instances for a repo (each may hold per-repo resolution state). */
export function createScanners(root: string): LanguageScanner[] {
  return [createTypeScriptScanner(root), createPythonScanner(root), createGoScanner(root)];
}

/** One-time async setup the tree-sitter scanners need (Python + Go WASM runtimes). Idempotent.
 *  Sequenced, not concurrent: both grammars load into web-tree-sitter's single shared WASM heap,
 *  and loading two at once races on that memory (a grammar can come back with a corrupt version). */
export function initGraphScanners(): Promise<void> {
  return initPythonScanner().then(() => initGoScanner());
}
