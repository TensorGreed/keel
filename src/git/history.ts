/**
 * Git history access, v0: shell out to `git log`. Zero dependencies, deterministic.
 * The event log (src/events/) will subsume this once SQLite persistence lands.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const FIELD_SEP = "";
const RECORD_SEP = "";

export interface CommitInfo {
  hash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string;
}

export async function historyFor(
  repoRoot: string,
  relPath: string,
  limit = 20,
): Promise<CommitInfo[]> {
  const format = ["%H", "%an", "%ae", "%aI", "%s", "%b"].join(FIELD_SEP) + RECORD_SEP;
  const { stdout } = await execFileAsync(
    "git",
    ["log", `--max-count=${limit}`, `--format=${format}`, "--follow", "--", relPath],
    { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout
    .split(RECORD_SEP)
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const [hash = "", author = "", email = "", date = "", subject = "", body = ""] =
        record.split(FIELD_SEP);
      return { hash, author, email, date, subject, body: body.trim() };
    });
}
