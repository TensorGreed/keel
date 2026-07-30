/**
 * Parser for `npm pack --dry-run --json` output, used by the publish-readiness guard
 * (test/package-tarball.test.ts) and pinned against recorded outputs by npm-pack-parse.test.ts.
 *
 * It lives in its own module, and is deliberately more forgiving than "JSON.parse and index [0]",
 * because that is what broke: a CI environment emitted a shape whose `parsed[0]` was `undefined`,
 * and the guard died taking every test in its file with it. npm's `--json` contract is not as
 * stable as it looks:
 *
 *   - **The envelope varies.** Some versions emit an array of one entry, others the entry object
 *     on its own. Indexing `[0]` silently yields `undefined` on the second, which then explodes
 *     somewhere less informative than where the assumption was made.
 *   - **The stream is not always pure JSON.** A config warning (`npm warn Unknown project config
 *     "always-auth"`) can land ahead of the document depending on version and log routing, so the
 *     text must be found inside the output rather than assumed to be all of it. Callers also pass
 *     `--loglevel=error` to cut that off at the source; this handles the case where that isn't
 *     enough.
 *   - **Entry shape varies.** Files are normally `{ path, size, mode }`; treat a bare string as a
 *     path too rather than dropping it.
 *
 * The one thing it will NOT do is guess: anything it can't confidently read returns `null`, and the
 * caller's job is to fail loudly with the raw output attached, so the next environment difference is
 * diagnosable from a CI log without reproducing it.
 */

/**
 * The file paths `npm pack --json` reported, or `null` if the output can't be read confidently.
 * Never throws — a caller decides what a `null` means.
 */
export function parseNpmPackOutput(raw: string): string[] | null {
  for (const start of jsonStartCandidates(raw)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.slice(start));
    } catch {
      continue; // this `[`/`{` was inside a warning, not the document — try the next one
    }
    for (const candidate of Array.isArray(parsed) ? parsed : [parsed]) {
      const files = filePathsOf(candidate);
      if (files) return files;
    }
  }
  return null;
}

/**
 * Offsets the JSON document might begin at, nearest first: the first `[` and the first `{`. Trying
 * both (rather than whichever comes first) covers a warning line that happens to contain a bracket
 * — a wrong guess fails to parse and we move on, since trailing content after a complete value is a
 * parse error rather than a silent partial read.
 */
function jsonStartCandidates(raw: string): number[] {
  return [raw.indexOf("["), raw.indexOf("{")].filter((i) => i >= 0).sort((a, b) => a - b);
}

/** The `files` list of one pack entry as plain paths, or null if this isn't a readable entry. */
function filePathsOf(value: unknown): string[] | null {
  if (typeof value !== "object" || value === null) return null;
  const files = (value as { files?: unknown }).files;
  if (!Array.isArray(files)) return null;

  const paths: string[] = [];
  for (const entry of files) {
    if (typeof entry === "string") {
      paths.push(entry);
    } else if (typeof entry === "object" && entry !== null && typeof (entry as { path?: unknown }).path === "string") {
      paths.push((entry as { path: string }).path);
    } else {
      return null; // an entry shape we don't understand — refuse rather than under-report the tarball
    }
  }
  // An empty list is not a pass: a package always ships package.json, so zero files means we read
  // the wrong thing.
  return paths.length > 0 ? paths : null;
}
