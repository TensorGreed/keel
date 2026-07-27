/**
 * Resolve which GitHub repo to ingest: from `git remote get-url origin` (https or ssh),
 * or a `--repo owner/repo` override. github.com only for now.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RepoRef {
  owner: string;
  repo: string;
}

export function repoSlug(ref: RepoRef): string {
  return `${ref.owner}/${ref.repo}`;
}

/**
 * Parse a github.com remote URL. Handles:
 *   https://github.com/owner/repo(.git)
 *   git@github.com:owner/repo(.git)
 *   ssh://git@github.com/owner/repo(.git)
 * Returns null for non-github.com or unparseable URLs.
 */
export function parseRemoteUrl(url: string): RepoRef | null {
  let s = url.trim().replace(/\/+$/, "");
  if (s.endsWith(".git")) s = s.slice(0, -4);
  const match = /github\.com[/:]([^/]+)\/([^/]+)$/.exec(s);
  if (!match) return null;
  const owner = match[1];
  const repo = match[2];
  if (!owner || !repo) return null;
  return { owner, repo };
}

/** Parse an explicit `owner/repo` override. */
export function parseSlug(slug: string): RepoRef | null {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(slug.trim());
  return match && match[1] && match[2] ? { owner: match[1], repo: match[2] } : null;
}

/** The repo to ingest: `--repo` override, else the origin remote. Error returned as data. */
export async function resolveRepoRef(
  repoRoot: string,
  override?: string,
): Promise<RepoRef | { error: string }> {
  if (override !== undefined) {
    const ref = parseSlug(override);
    return ref ?? { error: `--repo must be "owner/repo", got "${override}"` };
  }
  let url: string;
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: repoRoot });
    url = stdout.trim();
  } catch {
    return { error: "no 'origin' remote; pass --repo owner/repo" };
  }
  const ref = parseRemoteUrl(url);
  return ref ?? { error: `origin remote is not a github.com repo: ${url}` };
}
