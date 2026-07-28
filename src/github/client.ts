/**
 * Minimal GitHub REST client over Node's global fetch (no new deps). The GitHubClient
 * interface is the injectable seam — tests provide a fake backed by recorded JSON, so the
 * suite never touches the network. This is ETL plumbing: no model calls (see CLAUDE.md).
 */

export interface RateLimit {
  remaining: number;
  limit: number;
  /** epoch seconds when the window resets */
  reset: number;
}

export interface GitHubResponse<T> {
  data: T;
  /** the next page's path/URL from the Link header, or null on the last page */
  nextPage: string | null;
  rateLimit: RateLimit | null;
}

export interface GitHubClient {
  /** GET an API path (e.g. "/repos/o/r/pulls?...") or a full URL (for pagination). */
  get<T>(path: string): Promise<GitHubResponse<T>>;
  /** POST a JSON body to an API path (e.g. publishing a check run). */
  post<T>(path: string, body: unknown): Promise<GitHubResponse<T>>;
  /** whether requests are authenticated (affects rate limits) */
  authenticated: boolean;
}

/** A GitHub API failure surfaced as data, never a thrown stack trace. */
export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly rateLimit: RateLimit | null = null,
  ) {
    super(message);
    this.name = "GitHubError";
  }

  /** whether this is a rate-limit rejection (resumable by re-running later) */
  get isRateLimit(): boolean {
    return (this.status === 403 || this.status === 429) && this.rateLimit?.remaining === 0;
  }
}

const API_BASE = "https://api.github.com";

export class FetchGitHubClient implements GitHubClient {
  readonly authenticated: boolean;

  constructor(private readonly token?: string) {
    this.authenticated = Boolean(token);
  }

  get<T>(path: string): Promise<GitHubResponse<T>> {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body: unknown): Promise<GitHubResponse<T>> {
    return this.request<T>("POST", path, body);
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<GitHubResponse<T>> {
    const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "keel",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      throw new GitHubError(0, `network error contacting GitHub: ${(err as Error).message}`);
    }
    const rateLimit = parseRateLimit(res.headers);
    if (!res.ok) {
      let message = await errorMessage(res);
      if (res.status === 401 && this.token) {
        // Bad credentials with a token set almost always means the token itself is wrong,
        // not the request — point the user at GITHUB_TOKEN rather than relaying git-speak.
        message += " — your GITHUB_TOKEN appears invalid or expired; check it (or unset it to use unauthenticated access)";
      }
      throw new GitHubError(res.status, message, rateLimit);
    }
    const data = (await res.json()) as T;
    return { data, nextPage: parseNextLink(res.headers.get("link")), rateLimit };
  }
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    return `GitHub ${res.status}: ${body.message ?? res.statusText}`;
  } catch {
    return `GitHub ${res.status}: ${res.statusText}`;
  }
}

/** Extract the rel="next" URL from a Link header. */
export function parseNextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match) return match[1] ?? null;
  }
  return null;
}

export function parseRateLimit(headers: Headers): RateLimit | null {
  const remaining = headers.get("x-ratelimit-remaining");
  if (remaining === null) return null;
  return {
    remaining: Number(remaining),
    limit: Number(headers.get("x-ratelimit-limit") ?? 0),
    reset: Number(headers.get("x-ratelimit-reset") ?? 0),
  };
}
