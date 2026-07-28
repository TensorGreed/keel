import { describe, expect, it } from "vitest";
import { GitHubError, type GitHubClient, type GitHubResponse } from "../src/github/client.js";
import { buildCheckRun, postCheckRun } from "../src/github/check.js";
import type { Verdict, VerdictLevel } from "../src/trust/verdict.js";
import type { VerdictFacts } from "../src/trust/facts.js";

// buildCheckRun is a pure mapping from a verdict to the check-runs request body; postCheckRun
// is the only networked part, exercised here against a fake client (no real GitHub).

function verdict(level: VerdictLevel, over: Partial<Verdict> = {}): Verdict {
  const facts: VerdictFacts = {
    changedFiles: [{ path: "a.ts", status: "modified", inGraph: true }],
    blastRadius: 4,
    impacted: ["b.ts"],
    narrowedRadius: 2,
    sim: { status: level === "block" ? "failed" : "passed", passed: 3, failed: level === "block" ? 2 : 0, failures: [], budget: { maxTests: 50, maxSeconds: 120, testsSkipped: [], truncated: false } },
    uncoveredChanges: [],
    testsSelected: ["a.test.ts"],
    relevantDecisions: [],
    hasHumanDecision: false,
  };
  return {
    verdict: level,
    reasons: [{ rule: "requireSimPass", outcome: level, detail: level === "block" ? "2 test(s) failed: adds (a.test.ts)" : "all 3 selected test(s) passed" }],
    facts,
    policy: { source: "file" } as Verdict["policy"],
    ...over,
  };
}

class FakeClient implements GitHubClient {
  authenticated = true;
  posted: { path: string; body: unknown }[] = [];
  constructor(private readonly reply: () => GitHubResponse<unknown> | { throw: unknown }) {}
  get<T>(): Promise<GitHubResponse<T>> {
    throw new Error("not used");
  }
  async post<T>(path: string, body: unknown): Promise<GitHubResponse<T>> {
    this.posted.push({ path, body });
    const r = this.reply();
    if ("throw" in r) throw r.throw;
    return r as GitHubResponse<T>;
  }
}

const okReply = (data: unknown): GitHubResponse<unknown> => ({ data, nextPage: null, rateLimit: null });

describe("buildCheckRun", () => {
  it("maps block → failure with the failing rule in the body", () => {
    const req = buildCheckRun(verdict("block"), "abc1234");
    expect(req.name).toBe("keel/verdict");
    expect(req.head_sha).toBe("abc1234");
    expect(req.status).toBe("completed");
    expect(req.conclusion).toBe("failure");
    expect(req.output.title).toBe("Keel: block");
    expect(req.output.summary).toContain("blocked");
    expect(req.output.summary).toContain("Blast radius 4");
    expect(req.output.text).toContain("requireSimPass");
    expect(req.output.text).toContain("a.test.ts");
  });

  it("maps warn → neutral and pass → success", () => {
    expect(buildCheckRun(verdict("warn"), "s").conclusion).toBe("neutral");
    const pass = buildCheckRun(verdict("pass"), "s");
    expect(pass.conclusion).toBe("success");
    expect(pass.output.summary).toContain("within policy");
  });

  it("records the policy source in the check body", () => {
    expect(buildCheckRun(verdict("pass"), "s").output.text).toContain("file");
  });
});

describe("postCheckRun", () => {
  const ref = { owner: "o", repo: "r" };

  it("posts to the repo's check-runs endpoint and returns the html url", async () => {
    const client = new FakeClient(() => okReply({ id: 99, html_url: "https://github.com/o/r/runs/99" }));
    const res = await postCheckRun(client, ref, buildCheckRun(verdict("pass"), "sha1"));
    expect(res).toEqual({ id: 99, url: "https://github.com/o/r/runs/99" });
    expect(client.posted[0]!.path).toBe("/repos/o/r/check-runs");
    expect((client.posted[0]!.body as { head_sha: string }).head_sha).toBe("sha1");
  });

  it("explains a 403 as a missing checks:write permission", async () => {
    const client = new FakeClient(() => ({ throw: new GitHubError(403, "GitHub 403: Resource not accessible") }));
    const res = await postCheckRun(client, ref, buildCheckRun(verdict("pass"), "s"));
    expect(res).toMatchObject({ error: expect.stringContaining("checks:write") });
  });

  it("explains a 422 as an unpushed commit", async () => {
    const client = new FakeClient(() => ({ throw: new GitHubError(422, "GitHub 422: No commit found for SHA") }));
    const res = await postCheckRun(client, ref, buildCheckRun(verdict("pass"), "deadbeef"));
    expect(res).toMatchObject({ error: expect.stringContaining("deadbeef") });
  });

  it("surfaces a network error as data, never a throw", async () => {
    const client = new FakeClient(() => ({ throw: new GitHubError(0, "network error contacting GitHub: down") }));
    const res = await postCheckRun(client, ref, buildCheckRun(verdict("pass"), "s"));
    expect("error" in res).toBe(true);
  });
});
