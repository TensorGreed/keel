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

/** Every extension any scanner owns — the set the composer treats as graph source files. */
export const GRAPH_EXTENSIONS: ReadonlySet<string> = new Set([...TS_EXTENSIONS, ...PYTHON_EXTENSIONS]);

/** Fresh scanner instances for a repo (each may hold per-repo resolution state). */
export function createScanners(root: string): LanguageScanner[] {
  return [createTypeScriptScanner(root), createPythonScanner(root)];
}

/** One-time async setup any scanner needs (the Python WASM runtime). Idempotent. */
export function initGraphScanners(): Promise<void> {
  return initPythonScanner();
}
