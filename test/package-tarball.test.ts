/**
 * Publish-readiness guard: the npm tarball must ship the runnable package and nothing else. We
 * drive the real `npm pack --dry-run` so this tracks whatever `files` + npm's defaults resolve to,
 * rather than a hand-maintained list that could drift from package.json.
 *
 * Driving a real external tool means this file is also where the *environment* leaks in, and it has
 * bitten once: a CI runner emitted a `--json` shape whose `parsed[0]` was `undefined`, the parse
 * blew up in a shared setup path, and every test in the file died with it — a publish-readiness
 * failure reported as a crash with none of the evidence attached. Three rules follow from that, and
 * they're the shape of this file:
 *
 *   1. **Nothing runs at import.** npm is only probed for presence (a PATH lookup, no subprocess);
 *      the pack itself happens lazily inside a test, memoized. A broken npm can then only fail
 *      these tests, never take the file down before they run.
 *   2. **The parse assumes nothing** — see helpers/npm-pack.ts. `--loglevel=error` cuts warnings off
 *      at the source; the parser copes when that isn't enough.
 *   3. **A failure carries its evidence.** Any parse or shape problem fails with the raw stdout and
 *      stderr in the message, so the next environment difference is diagnosable from the CI log
 *      alone, without reproducing it.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOnPath } from "../src/util/platform.js";
import { npmCapture, type CommandRun } from "./helpers/platform.js";
import { parseNpmPackOutput } from "./helpers/npm-pack.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Presence only — a PATH lookup, so this stays safe at module load. */
const NPM_ON_PATH = resolveOnPath("npm") !== null;

/** Memoized across the tests in this file: one pack run, whatever its outcome. */
let cachedRun: CommandRun | undefined;
let cachedFiles: string[] | undefined;

/** Everything a reader needs to diagnose the run without re-creating the environment. */
function evidence(run: CommandRun): string {
  return [
    `command: ${run.command} (cwd ${repoRoot})`,
    `exit status: ${run.status ?? "null"}${run.spawnError ? ` — spawn error: ${run.spawnError}` : ""}`,
    `--- stdout (${run.stdout.length} bytes) ---`,
    run.stdout,
    `--- stderr (${run.stderr.length} bytes) ---`,
    run.stderr,
  ].join("\n");
}

/**
 * The tarball's file list. Builds first if a clean checkout hasn't (pack lists dist/ only if it
 * exists), then packs. Lazy and memoized: called from inside a test, so any failure is that test's
 * failure, with the evidence attached.
 */
function packedFiles(): string[] {
  if (cachedFiles) return cachedFiles;

  if (!fs.existsSync(path.join(repoRoot, "dist", "index.js"))) {
    const build = npmCapture(["run", "build", "--loglevel=error"], { cwd: repoRoot });
    expect(build.status, `\`npm run build\` failed, so there is no dist/ to pack.\n${evidence(build)}`).toBe(0);
  }

  const run = (cachedRun ??= npmCapture(["pack", "--dry-run", "--json", "--loglevel=error"], { cwd: repoRoot }));

  // Try stdout alone first — the documented channel — then the combined stream, in case a version
  // routes the document to stderr. Both failing is a shape we don't understand, and that's reported.
  const files = parseNpmPackOutput(run.stdout) ?? parseNpmPackOutput(`${run.stdout}\n${run.stderr}`);
  expect(
    files,
    "could not read a file list out of `npm pack --json`. npm's --json envelope varies by major " +
      "version (array vs bare object) and warnings can precede the document; if this is a NEW shape, " +
      "record it under test/fixtures/npm-pack/ and teach helpers/npm-pack.ts to read it.\n" +
      evidence(run),
  ).not.toBeNull();

  cachedFiles = files!;
  return cachedFiles;
}

describe.skipIf(!NPM_ON_PATH)("npm package tarball (needs npm on PATH)", () => {
  it("ships the runnable CLI, its schema asset, and the docs users need", () => {
    const files = packedFiles();
    for (const required of [
      "package.json",
      "README.md",
      "LICENSE",
      "CHANGELOG.md", // what a consumer reads to decide whether to upgrade
      "dist/index.js",
      "dist/events/schema.sql", // copied next to the compiled store; the DB won't open without it
      // Every tree-sitter grammar, not just Python's: each ships so installs stay zero-build, and a
      // missing one breaks that language's scanner at runtime with nothing at install time to hint why.
      "dist/graph/wasm/tree-sitter-python.wasm",
      "dist/graph/wasm/tree-sitter-go.wasm",
      "dist/graph/wasm/tree-sitter-java.wasm",
      "recipes/claude-code-hook.md",
      "recipes/github-check.md",
      "docs/concept.md",
    ]) {
      expect(files, `expected ${required} in the tarball`).toContain(required);
    }
  }, 120_000);

  it("excludes source, tests, and repo-local config", () => {
    const leaked = packedFiles().filter((p) =>
      /^src\//.test(p) ||
      /^test\//.test(p) ||
      /^node_modules\//.test(p) ||
      /\.bundle$/.test(p) ||
      p === ".mcp.json" ||
      p === "keel.policy.json" ||
      p.startsWith(".claude/"),
    );
    expect(leaked, `these should not ship: ${leaked.join(", ")}`).toEqual([]);
  }, 120_000);
});
