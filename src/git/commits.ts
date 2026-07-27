/**
 * List commits with the files each one touched, for event-log ingestion.
 * Shells out to `git log --name-status` (zero deps, deterministic). Separate from
 * history.ts, which serves get_history's per-path, rename-following queries.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Control-byte separators git will never emit inside the fields we ask for: RS between
// commits, US between fields. Subject (%s) is placed last so the name-status lines that
// git appends after the format can be split off it by the first newline, while the body
// (%b, which may contain newlines) sits safely between two US bytes.
const RECORD_SEP = "\x1e";
const FIELD_SEP = "\x1f";
const FORMAT = `${RECORD_SEP}%H${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%aI${FIELD_SEP}%b${FIELD_SEP}%s`;

export interface CommitRecord {
  sha: string;
  author: string;
  email: string;
  date: string; // ISO 8601 (author date)
  subject: string;
  body: string;
  /** repo-relative paths touched by the commit (both sides of a rename) */
  files: string[];
}

export interface ListCommitsOptions {
  /** a git revision range, e.g. "<sha>..HEAD"; omit for the whole history */
  range?: string;
  /** cap the number of commits returned (used to bound the initial backfill) */
  limit?: number;
}

/**
 * Returns commits newest-first. Renames are disabled (`--no-renames`) so results don't
 * depend on the repo's diff.renames config: a rename shows as a delete + an add, and
 * both paths are recorded as touched. Returns [] for a repo with no commits yet; throws
 * on any other git failure (e.g. an unknown range) so the caller can react.
 */
export async function listCommits(
  repoRoot: string,
  options: ListCommitsOptions = {},
): Promise<CommitRecord[]> {
  const args = ["log", "--no-renames", "--name-status", `--format=${FORMAT}`];
  if (options.limit !== undefined) args.push(`--max-count=${options.limit}`);
  if (options.range !== undefined) args.push(options.range);

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("git", args, {
      cwd: repoRoot,
      maxBuffer: 256 * 1024 * 1024,
    }));
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "");
    if (/does not have any commits yet|bad default revision/i.test(stderr)) return [];
    throw err;
  }
  return parseCommits(stdout);
}

function parseCommits(stdout: string): CommitRecord[] {
  const commits: CommitRecord[] = [];
  for (const segment of stdout.split(RECORD_SEP)) {
    const trimmed = segment.replace(/\s+$/, "");
    if (trimmed === "") continue;

    const fields = trimmed.split(FIELD_SEP);
    if (fields.length < 6) continue;
    const [sha, author, email, date, body] = fields;
    const subjectAndFiles = fields[5] ?? "";

    const lines = subjectAndFiles.split("\n");
    const subject = lines[0] ?? "";
    const files = new Set<string>();
    for (const line of lines.slice(1)) {
      if (line === "") continue;
      // With --no-renames every line is "<STATUS>\t<path>"; take the path.
      const parts = line.split("\t");
      for (const p of parts.slice(1)) if (p !== "") files.add(p);
    }

    commits.push({
      sha: sha ?? "",
      author: author ?? "",
      email: email ?? "",
      date: date ?? "",
      subject,
      body: (body ?? "").trim(),
      files: [...files],
    });
  }
  return commits;
}
