import { afterEach, describe, expect, it, vi } from "vitest";
import { FetchGitHubClient, GitHubError } from "../src/github/client.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function stub401(): void {
  globalThis.fetch = vi.fn(
    async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }),
  ) as typeof fetch;
}

describe("FetchGitHubClient 401 handling", () => {
  it("flags an invalid/expired token when one was set", async () => {
    stub401();
    await expect(new FetchGitHubClient("ghp_bogus").get("/repos/o/r/pulls")).rejects.toMatchObject({
      status: 401,
    });
    try {
      await new FetchGitHubClient("ghp_bogus").get("/repos/o/r/pulls");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubError);
      const message = (err as GitHubError).message;
      expect(message).toContain("Bad credentials"); // still relays GitHub's own message
      expect(message).toContain("GITHUB_TOKEN");
      expect(message).toMatch(/invalid or expired/i);
    }
  });

  it("does not add a token hint when unauthenticated", async () => {
    stub401();
    try {
      await new FetchGitHubClient().get("/repos/o/r/pulls");
      expect.fail("should have thrown");
    } catch (err) {
      const message = (err as GitHubError).message;
      expect(message).toContain("Bad credentials");
      expect(message).not.toContain("GITHUB_TOKEN");
    }
  });
});
