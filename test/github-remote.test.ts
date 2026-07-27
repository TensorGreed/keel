import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseRemoteUrl, parseSlug, resolveRepoRef } from "../src/github/remote.js";

describe("parseRemoteUrl", () => {
  it("parses https, ssh, and ssh:// forms, with or without .git", () => {
    expect(parseRemoteUrl("https://github.com/anthropics/keel.git")).toEqual({ owner: "anthropics", repo: "keel" });
    expect(parseRemoteUrl("https://github.com/anthropics/keel")).toEqual({ owner: "anthropics", repo: "keel" });
    expect(parseRemoteUrl("git@github.com:anthropics/keel.git")).toEqual({ owner: "anthropics", repo: "keel" });
    expect(parseRemoteUrl("ssh://git@github.com/anthropics/keel")).toEqual({ owner: "anthropics", repo: "keel" });
    expect(parseRemoteUrl("https://github.com/anthropics/keel/")).toEqual({ owner: "anthropics", repo: "keel" });
  });

  it("returns null for non-github or unparseable remotes", () => {
    expect(parseRemoteUrl("https://gitlab.com/foo/bar.git")).toBeNull();
    expect(parseRemoteUrl("not a url")).toBeNull();
  });
});

describe("parseSlug", () => {
  it("accepts owner/repo and rejects the rest", () => {
    expect(parseSlug("anthropics/keel")).toEqual({ owner: "anthropics", repo: "keel" });
    expect(parseSlug("keel")).toBeNull();
    expect(parseSlug("a/b/c")).toBeNull();
  });
});

describe("resolveRepoRef", () => {
  it("prefers an explicit --repo override", async () => {
    expect(await resolveRepoRef("/nonexistent", "o/r")).toEqual({ owner: "o", repo: "r" });
  });

  it("derives from the origin remote of a real repo", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-remote-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["remote", "add", "origin", "git@github.com:anthropics/keel.git"], { cwd: dir });
      expect(await resolveRepoRef(dir)).toEqual({ owner: "anthropics", repo: "keel" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an error (not a throw) when there is no origin", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-noremote-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      const ref = await resolveRepoRef(dir);
      expect("error" in ref).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
