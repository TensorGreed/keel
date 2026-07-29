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

describe("FetchGitHubClient per-request timeout", () => {
  it("surfaces a stalled request as a resumable, timed-out GitHubError (never hangs)", async () => {
    // A fetch that resolves only when its AbortSignal fires — as a real stalled connection would.
    globalThis.fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject((init.signal as AbortSignal).reason));
        }),
    ) as typeof fetch;

    try {
      await new FetchGitHubClient(undefined, 20).get("/repos/o/r/pulls"); // 20ms timeout
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubError);
      const e = err as GitHubError;
      expect(e.timedOut).toBe(true);
      expect(e.status).toBe(0);
      expect(e.message).toMatch(/timed out/i);
    }
  }, 2000);
});
