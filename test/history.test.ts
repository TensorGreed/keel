import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { historyFor } from "../src/git/history.js";

// Uses this repo's own git history — guaranteed present.
const repoRoot = path.join(__dirname, "..");

describe("git history", () => {
  it("returns commits for a tracked path", async () => {
    const commits = await historyFor(repoRoot, "README.md", 5);
    expect(commits.length).toBeGreaterThan(0);
    const first = commits[0]!;
    expect(first.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(first.subject.length).toBeGreaterThan(0);
    expect(first.date.length).toBeGreaterThan(0);
  });

  it("returns empty for an untracked path", async () => {
    const commits = await historyFor(repoRoot, "does/not/exist.ts", 5);
    expect(commits).toEqual([]);
  });
});
