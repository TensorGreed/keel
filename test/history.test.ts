import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { historyFor } from "../src/git/history.js";

// A hermetic temp repo with known history. Earlier this ran against keel's own checkout, which
// is fragile in CI: actions/checkout does a shallow clone (so `git log -- README.md` can be
// empty) and git's dubious-ownership guard can reject a bind-mounted workspace. Owning the repo
// here makes the test independent of how CI checks the code out.

function git(dir: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@example.com",
      GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@example.com",
      GIT_AUTHOR_DATE: "2021-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2021-01-01T00:00:00Z",
    },
  });
}

let repoRoot: string;

beforeAll(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keel-history-"));
  git(repoRoot, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "# hello\n");
  git(repoRoot, ["add", "-A"]);
  git(repoRoot, ["commit", "-qm", "add readme"]);
  fs.appendFileSync(path.join(repoRoot, "README.md"), "more\n");
  git(repoRoot, ["commit", "-qam", "expand readme"]);
});
afterAll(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

describe("git history", () => {
  it("returns commits for a tracked path, newest first", async () => {
    const commits = await historyFor(repoRoot, "README.md", 5);
    expect(commits).toHaveLength(2);
    const first = commits[0]!;
    expect(first.subject).toBe("expand readme"); // most recent
    expect(first.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(first.date.length).toBeGreaterThan(0);
    expect(first.author).toBe("Dev");
  });

  it("returns empty for an untracked path", async () => {
    expect(await historyFor(repoRoot, "does/not/exist.ts", 5)).toEqual([]);
  });
});
