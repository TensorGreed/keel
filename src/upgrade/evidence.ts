/**
 * Package evidence: what the dependency itself says about the change, gathered for a repair task.
 *
 * Keel doesn't write the fix — principle 1 puts that in the caller's agent — so its job is to put
 * everything needed to write it in one place, and nothing that isn't. Four things, all derived from
 * files already on disk, with no network call and no model:
 *
 *   - **The symbols in play.** Which exports of the package a given import site actually uses,
 *     re-read from the source by the same scanner that built the graph. Exact, per-language, and the
 *     thing that turns "lodash changed" into "you call `pick` and `merge` here".
 *   - **The changelog, sliced.** The package's own CHANGELOG between the two versions — the place a
 *     maintainer writes migration notes — plus the specific lines mentioning the symbols in play.
 *   - **The package's own diff.** A real unified diff of its `package.json` and entry file between
 *     the installed old version and the new one. Both are on disk (old in the repo's node_modules,
 *     new in the sandbox), so this is `git diff --no-index`, not a reimplementation.
 *   - **What's missing, said out loud.** A package with no changelog, or a minified bundle no diff
 *     could illuminate, produces a *note* rather than a silently empty field. An agent that knows
 *     evidence is absent behaves differently from one that thinks there was nothing to say.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createScanners } from "../graph/scanners.js";
import { WHOLE_MODULE } from "../graph/scanner.js";
import { execFileTimed } from "../util/timeouts.js";
import { specifierMatchesPackage } from "./scope.js";

/** Files a package might keep its history in, in the order we prefer them. */
const CHANGELOG_NAMES = ["CHANGELOG.md", "CHANGELOG", "CHANGES.md", "HISTORY.md", "CHANGELOG.txt"];
/** Beyond this a file is a bundle, not something a diff will illuminate. */
const MAX_DIFFABLE_BYTES = 256 * 1024;
/** A line this long means minified output — diffing it produces one unreadable mega-line. */
const MINIFIED_LINE_LENGTH = 2_000;
const MAX_DIFF_LINES = 200;
const MAX_CHANGELOG_LINES = 120;

export interface PackageSnapshot {
  version: string | null;
  /** absolute path to the installed package directory */
  dir: string;
  /** absolute path to the package's entry file, when it resolves to something readable */
  entry: string | null;
  /** absolute path to its changelog, when it ships one */
  changelog: string | null;
}

export interface PackageEvidence {
  fromVersion: string | null;
  toVersion: string | null;
  changelog: {
    /** the file name as published, e.g. CHANGELOG.md */
    file: string;
    excerpt: string;
    /** true when both version headings were found and the excerpt is exactly the span between them */
    spanned: boolean;
    /** excerpt lines naming a symbol the import sites actually use */
    symbolMentions: string[];
  } | null;
  /** unified diff of the package's manifest + entry between the two installed versions */
  diff: { files: string[]; patch: string; truncated: boolean } | null;
  /** everything the evidence could NOT establish, and why */
  notes: string[];
}

/** Locate an installed package and the two files worth reading from it. */
export function readPackageSnapshot(nodeModulesRoot: string, pkg: string): PackageSnapshot | null {
  const dir = path.join(nodeModulesRoot, "node_modules", ...pkg.split("/"));
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  return {
    version: typeof manifest["version"] === "string" ? manifest["version"] : null,
    dir,
    entry: resolveEntry(dir, manifest),
    changelog: CHANGELOG_NAMES.map((n) => path.join(dir, n)).find(isReadableFile) ?? null,
  };
}

/** The package's main entry file, from `exports["."]`, `module`, or `main` — first that exists. */
function resolveEntry(dir: string, manifest: Record<string, unknown>): string | null {
  const candidates: string[] = [];
  const exportsField = manifest["exports"];
  for (const value of exportTargets(exportsField)) candidates.push(value);
  for (const field of ["module", "main"]) {
    const value = manifest[field];
    if (typeof value === "string") candidates.push(value);
  }
  candidates.push("index.js", "index.mjs", "index.cjs");
  for (const rel of candidates) {
    const abs = path.join(dir, rel);
    if (isReadableFile(abs)) return abs;
  }
  return null;
}

/** Concrete file targets from a package.json `exports` value — the "." entry, however it's nested. */
function exportTargets(value: unknown, depth = 0): string[] {
  if (typeof value === "string") return [value];
  if (depth > 3 || typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  // Prefer the root entry and the conditions a source-level reader wants.
  for (const key of [".", "import", "require", "default", "node"]) {
    if (key in record) return exportTargets(record[key], depth + 1);
  }
  return [];
}

/**
 * The package's exports that `file` actually uses, read by the scanner that owns its language. A
 * single-file re-scan: cheap, exact, and it needs no new graph state (the graph stores external
 * specifiers, not the symbols pulled through them). `*` means the whole module escaped into the
 * file — a namespace import or a `require` whose result wasn't destructured — so every export is
 * potentially in play and the caller should say so rather than list nothing.
 */
export function symbolsInPlay(repoRoot: string, relFile: string, pkg: string): string[] {
  const abs = path.join(repoRoot, relFile);
  let content: string;
  try {
    content = fs.readFileSync(abs, "utf8");
  } catch {
    return [];
  }
  const ext = path.extname(abs);
  const scanner = createScanners(repoRoot).find((s) => s.extensions.has(ext));
  if (!scanner) return [];

  const symbols = new Set<string>();
  try {
    for (const imported of scanner.scanFile(abs, content).imports) {
      if (!specifierMatchesPackage(imported.specifier, pkg)) continue;
      for (const symbol of imported.symbols) symbols.add(symbol);
    }
  } catch {
    return []; // an unparseable file is the caller's problem to see, not a reason to throw here
  }
  return [...symbols].sort();
}

/**
 * The changelog span between two versions. Headings vary far too much to parse strictly, so this
 * anchors on the semver a heading contains rather than on its shape: take from the heading naming
 * the new version down to (not including) the one naming the old. If either anchor is missing we
 * fall back to the top of the file and say so via `spanned: false` — a "here's the top of the
 * changelog" excerpt is useful, but it must not be mistaken for "here is what changed".
 */
export function sliceChangelog(
  content: string,
  fromVersion: string | null,
  toVersion: string | null,
): { excerpt: string; spanned: boolean } {
  const lines = content.split(/\r?\n/);
  const headingFor = (version: string | null): number => {
    if (!version) return -1;
    const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|[^\\d.])${escaped}([^\\d.]|$)`);
    return lines.findIndex((l) => /^\s{0,3}(#{1,4}\s|={2,}|\[)/.test(l) && re.test(l));
  };

  const start = headingFor(toVersion);
  const end = headingFor(fromVersion);
  const spanned = start >= 0 && end > start;
  const slice = spanned ? lines.slice(start, end) : lines.slice(start >= 0 ? start : 0);
  const capped = slice.slice(0, MAX_CHANGELOG_LINES);
  const excerpt = capped.join("\n").trim() + (slice.length > capped.length ? `\n… (${slice.length - capped.length} more lines)` : "");
  return { excerpt, spanned };
}

/** Changelog lines that name a symbol the code actually uses — the ones worth reading first. */
function mentionsOf(excerpt: string, symbols: string[]): string[] {
  const named = symbols.filter((s) => s !== WHOLE_MODULE && /^[A-Za-z_$][\w$]*$/.test(s));
  if (named.length === 0) return [];
  const patterns = named.map((s) => new RegExp(`\\b${s}\\b`));
  return excerpt
    .split("\n")
    .filter((line) => patterns.some((re) => re.test(line)))
    .slice(0, 20);
}

/** Is this file worth diffing, or is it a bundle a diff can only obscure? */
function diffable(file: string): { ok: true } | { ok: false; reason: string } {
  let content: string;
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_DIFFABLE_BYTES) return { ok: false, reason: `${path.basename(file)} is ${Math.round(stat.size / 1024)}KB — too large to diff usefully` };
    content = fs.readFileSync(file, "utf8");
  } catch {
    return { ok: false, reason: `${path.basename(file)} could not be read` };
  }
  if (content.split("\n").some((l) => l.length > MINIFIED_LINE_LENGTH)) {
    return { ok: false, reason: `${path.basename(file)} looks minified — a line diff of it would be unreadable` };
  }
  return { ok: true };
}

/**
 * Assemble the evidence for one upgrade. `previous` is the version installed in the repo today,
 * `next` the one installed in the sandbox; either may be absent, and absence is reported.
 */
export async function buildPackageEvidence(
  previous: PackageSnapshot | null,
  next: PackageSnapshot | null,
  symbols: string[],
  budgetMs: number,
): Promise<PackageEvidence> {
  const notes: string[] = [];
  const evidence: PackageEvidence = {
    fromVersion: previous?.version ?? null,
    toVersion: next?.version ?? null,
    changelog: null,
    diff: null,
    notes,
  };

  if (!next) {
    notes.push("the new version was not readable on disk — no package evidence could be gathered");
    return evidence;
  }
  if (!previous) notes.push("the previous version is not installed in this repo, so no before/after diff is possible");

  // --- changelog ---
  if (next.changelog) {
    try {
      const { excerpt, spanned } = sliceChangelog(fs.readFileSync(next.changelog, "utf8"), previous?.version ?? null, next.version);
      const symbolMentions = mentionsOf(excerpt, symbols);
      evidence.changelog = { file: path.basename(next.changelog), excerpt, spanned, symbolMentions };
      if (!spanned) {
        notes.push(`${path.basename(next.changelog)} has no heading naming both versions — the excerpt is its top, NOT the span between them`);
      }
    } catch {
      notes.push(`${path.basename(next.changelog)} could not be read`);
    }
  } else {
    notes.push("the package ships no CHANGELOG — its own migration notes are unavailable");
  }

  // --- the package's own diff ---
  if (previous) {
    const pairs: { label: string; a: string; b: string }[] = [
      { label: "package.json", a: path.join(previous.dir, "package.json"), b: path.join(next.dir, "package.json") },
    ];
    if (previous.entry && next.entry) {
      pairs.push({ label: path.relative(next.dir, next.entry), a: previous.entry, b: next.entry });
    } else {
      notes.push("the package's entry file could not be resolved on both sides — the diff covers package.json only");
    }

    const chunks: string[] = [];
    const files: string[] = [];
    let truncated = false;
    for (const pair of pairs) {
      const a = diffable(pair.a);
      const b = diffable(pair.b);
      if (!a.ok || !b.ok) {
        notes.push(!a.ok ? a.reason : (b as { reason: string }).reason);
        continue;
      }
      const raw = await gitDiffNoIndex(pair.a, pair.b, budgetMs);
      if (raw === null) continue;
      if (raw.trim() === "") continue; // identical — nothing to say
      // `--no-index` puts absolute paths in the headers, and one side lives in a temp sandbox. Those
      // paths are noise to a reader and meaningless to anyone else, so label them by version.
      const patch = relabel(raw, previous.dir, next.dir, previous.version, next.version);
      const lines = patch.split("\n");
      if (lines.length > MAX_DIFF_LINES) {
        truncated = true;
        chunks.push(`${lines.slice(0, MAX_DIFF_LINES).join("\n")}\n… (${lines.length - MAX_DIFF_LINES} more diff lines)`);
      } else {
        chunks.push(patch);
      }
      files.push(pair.label);
    }
    if (chunks.length > 0) evidence.diff = { files, patch: chunks.join("\n"), truncated };
  }

  return evidence;
}

/**
 * Rewrite `--no-index` header paths to `<pkg>@<version>/<file>`. Purely cosmetic, but a diff whose
 * every header is a 90-character temp path is one a reader skips.
 */
function relabel(patch: string, oldDir: string, newDir: string, oldVersion: string | null, newVersion: string | null): string {
  const label = (dir: string, version: string | null): [RegExp, string] => [
    new RegExp(escapeRegExp(dir.replace(/^\/+/, "")).replace(/\\\//g, "/"), "g"),
    `${path.basename(dir)}@${version ?? "?"}`,
  ];
  let out = patch;
  for (const [re, replacement] of [label(oldDir, oldVersion), label(newDir, newVersion)]) out = out.replace(re, replacement);
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `git diff --no-index a b` — exits 1 when they differ, which is the normal case here. */
async function gitDiffNoIndex(a: string, b: string, budgetMs: number): Promise<string | null> {
  try {
    const { stdout } = await execFileTimed("git", ["diff", "--no-index", "--no-color", "-U3", a, b], {
      timeoutMs: budgetMs,
      maxBuffer: 8 * 1024 * 1024,
      label: "git diff --no-index",
    });
    return stdout;
  } catch (err) {
    const e = err as { stdout?: string; code?: unknown };
    // Exit 1 just means "they differ" — the diff is on stdout. Anything else, we have no evidence.
    return typeof e.stdout === "string" && e.stdout.trim() !== "" ? e.stdout : null;
  }
}

function isReadableFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}
