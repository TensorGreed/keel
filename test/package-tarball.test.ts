import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Publish-readiness guard: the npm tarball must ship the runnable package and nothing else.
// We drive the real `npm pack --dry-run` so this tracks whatever "files" + npm defaults resolve
// to, not a hand-maintained list that could drift from package.json.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function packedFiles(): string[] {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: repoRoot, encoding: "utf8" });
  const parsed = JSON.parse(out) as { files: { path: string }[] }[];
  return parsed[0]!.files.map((f) => f.path);
}

describe("npm package tarball", () => {
  let files: string[];

  beforeAll(() => {
    // pack lists dist/ only if it's been built; build once if a clean checkout hasn't.
    if (!fs.existsSync(path.join(repoRoot, "dist", "index.js"))) {
      execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "ignore" });
    }
    files = packedFiles();
  }, 120_000);

  it("ships the runnable CLI, its schema asset, and the docs users need", () => {
    for (const required of [
      "package.json",
      "README.md",
      "LICENSE",
      "dist/index.js",
      "dist/events/schema.sql", // copied next to the compiled store; the DB won't open without it
      "dist/graph/wasm/tree-sitter-python.wasm", // the Python grammar — ships so installs stay zero-build
      "recipes/claude-code-hook.md",
      "docs/concept.md",
    ]) {
      expect(files, `expected ${required} in the tarball`).toContain(required);
    }
  });

  it("excludes source, tests, and repo-local config", () => {
    const leaked = files.filter((p) =>
      /^src\//.test(p) ||
      /^test\//.test(p) ||
      /^node_modules\//.test(p) ||
      /\.bundle$/.test(p) ||
      p === ".mcp.json" ||
      p === "keel.policy.json" ||
      p.startsWith(".claude/"),
    );
    expect(leaked, `these should not ship: ${leaked.join(", ")}`).toEqual([]);
  });
});
