/**
 * The `npm pack --json` parser, pinned against RECORDED outputs rather than hand-written strings.
 *
 * These fixtures exist because the publish-readiness guard broke on a shape nobody had seen:
 * `JSON.parse(out)[0].files` assumed one exact envelope, and an environment that produced a
 * different one turned a publishing check into a crash. Recording each shape as a file means the
 * next difference is a fixture plus a case here, not a rewrite — and it keeps the parser honest
 * about output it was never shown.
 *
 * The recordings are snapshots pinned in time, not mirrors of the current package: they carry the
 * version and file list of the release they were taken from and never need refreshing.
 *
 *   - `npm-11-array.json`     — npm 11.9.0, verbatim: a one-element array, clean stdout.
 *   - `npm-warn-prefixed.txt` — the same document behind the `always-auth` config warnings the CI
 *                               runner emitted, i.e. the stream is not pure JSON.
 *   - `npm-object-shape.txt`  — the entry object on its own, no array wrapper. This is the one that
 *                               actually bit: `JSON.parse` succeeds, `parsed[0]` is `undefined`,
 *                               and the failure surfaces far from the assumption that caused it.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseNpmPackOutput } from "./helpers/npm-pack.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "npm-pack");
const recorded = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), "utf8");

/** Files every recording must contain, whatever the envelope — enough to prove a real read. */
const EXPECTED_SAMPLE = ["package.json", "README.md", "dist/index.js", "dist/graph/wasm/tree-sitter-java.wasm"];

describe("parseNpmPackOutput — recorded npm shapes", () => {
  for (const [label, fixture] of [
    ["npm 11 array form, clean stdout", "npm-11-array.json"],
    ["array form behind npm config warnings", "npm-warn-prefixed.txt"],
    ["bare object form behind npm config warnings", "npm-object-shape.txt"],
  ] as const) {
    it(`reads ${label}`, () => {
      const files = parseNpmPackOutput(recorded(fixture));
      expect(files, `${fixture} must yield a file list`).not.toBeNull();
      for (const required of EXPECTED_SAMPLE) expect(files).toContain(required);
      expect(files!.length).toBeGreaterThan(50);
    });
  }

  it("reads every shape to the same file list — the envelope must not change the answer", () => {
    const [array, warned, object] = ["npm-11-array.json", "npm-warn-prefixed.txt", "npm-object-shape.txt"].map((f) =>
      parseNpmPackOutput(recorded(f)),
    );
    expect(warned).toEqual(array);
    expect(object).toEqual(array);
  });
});

describe("parseNpmPackOutput — shapes it must refuse rather than guess", () => {
  it("returns null for output with no JSON at all", () => {
    expect(parseNpmPackOutput("")).toBeNull();
    expect(parseNpmPackOutput("npm error code ENOENT\nnpm error syscall spawn\n")).toBeNull();
  });

  it("returns null for truncated or malformed JSON", () => {
    expect(parseNpmPackOutput('[{"files": [{"path": "a.js"}')).toBeNull();
    expect(parseNpmPackOutput("[not json at all]")).toBeNull();
  });

  it("returns null when the document has no files list", () => {
    expect(parseNpmPackOutput('[{"id":"pkg@1.0.0","name":"pkg"}]')).toBeNull();
    expect(parseNpmPackOutput('{"id":"pkg@1.0.0"}')).toBeNull();
    expect(parseNpmPackOutput('{"files": "not-a-list"}')).toBeNull();
  });

  it("treats an EMPTY file list as unreadable, not as an empty tarball", () => {
    // Every package ships package.json, so zero files means we read the wrong thing — and silently
    // returning [] would make "excludes source, tests, and repo-local config" pass vacuously.
    expect(parseNpmPackOutput('[{"files": []}]')).toBeNull();
  });

  it("refuses an entry shape it doesn't understand rather than under-reporting the tarball", () => {
    expect(parseNpmPackOutput('[{"files": [{"path": "a.js"}, {"name": "b.js"}]}]')).toBeNull();
  });
});

describe("parseNpmPackOutput — variations it should absorb", () => {
  it("accepts file entries given as bare strings", () => {
    expect(parseNpmPackOutput('{"files": ["package.json", "dist/index.js"]}')).toEqual(["package.json", "dist/index.js"]);
  });

  it("finds the document when a warning line itself contains a bracket", () => {
    // The first `[` is inside the warning, so parsing from there fails; the parser must fall through
    // to the next candidate offset instead of giving up.
    const out = 'npm warn [deprecated] something about a config\n{"files": [{"path": "package.json"}]}';
    expect(parseNpmPackOutput(out)).toEqual(["package.json"]);
  });

  it("takes the first entry that has a files list when several are present", () => {
    expect(parseNpmPackOutput('[{"id":"a"},{"files":[{"path":"package.json"}]}]')).toEqual(["package.json"]);
  });
});
