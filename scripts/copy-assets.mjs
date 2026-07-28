// tsc only emits JS; runtime assets (the SQLite schema, the tree-sitter Python grammar) are
// read relative to their compiled module. Copy them next to the emitted JS so dist/ is runnable
// and the published tarball is zero-build.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const assets = [
  ["src/events/schema.sql", "dist/events/schema.sql"],
  ["src/graph/wasm/tree-sitter-python.wasm", "dist/graph/wasm/tree-sitter-python.wasm"],
];

for (const [src, dest] of assets) {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}
