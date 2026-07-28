/**
 * Publish a Keel verdict as a GitHub Check Run, so a PR gets a native ✓/✗ next to Keel's
 * reasons. This is ETL plumbing — it maps the already-computed verdict onto the check-runs
 * API and POSTs it. No model calls, no re-evaluation: the verdict is the source of truth.
 *
 * The verdict judges a diff applied onto HEAD, so a meaningful PR check runs with HEAD at the
 * base and the PR's forward diff fed in (see recipes/github-check.md); --sha attaches the
 * result to the PR head commit regardless of which commit is checked out.
 */
import { GitHubError, type GitHubClient } from "./client.js";
import { repoSlug, type RepoRef } from "./remote.js";
import type { Verdict, VerdictLevel } from "../trust/verdict.js";

/** GitHub check-run conclusions we use: block fails the check, warn is neutral, pass succeeds. */
const CONCLUSION: Record<VerdictLevel, "success" | "neutral" | "failure"> = {
  pass: "success",
  warn: "neutral",
  block: "failure",
};

const MARK: Record<VerdictLevel, string> = { pass: "✓", warn: "⚠", block: "✗" };

export interface CheckRunRequest {
  name: string;
  head_sha: string;
  status: "completed";
  conclusion: "success" | "neutral" | "failure";
  output: { title: string; summary: string; text: string };
}

/** The GitHub check-run fields we read back after creating it. */
interface CheckRunResponse {
  id: number;
  html_url: string;
}

function simLine(v: Verdict): string {
  const sim = v.facts.sim;
  const counts = sim.passed !== undefined ? ` (${sim.passed} passed, ${sim.failed ?? 0} failed)` : "";
  return `Blast radius ${v.facts.blastRadius}, sim **${sim.status}**${counts}.`;
}

/** Map a verdict to a check-run request body. Pure — no network, so it's fully unit-testable. */
export function buildCheckRun(verdict: Verdict, headSha: string): CheckRunRequest {
  const level = verdict.verdict;
  const title = `Keel: ${level}`;
  const headline =
    level === "block"
      ? "Keel blocked this change — address the failing rules below."
      : level === "warn"
        ? "Keel passed with warnings — review the notes below."
        : "Keel passed: the change is within policy.";

  const reasons = verdict.reasons.map((r) => `- ${MARK[r.outcome]} **${r.rule}** — ${r.detail}`).join("\n");
  const summary = `${headline}\n\n${simLine(verdict)}`;
  const text = `Policy source: \`${verdict.policy.source}\`\n\n${reasons || "_no rules configured_"}`;

  return {
    name: "keel/verdict",
    head_sha: headSha,
    status: "completed",
    conclusion: CONCLUSION[level],
    output: { title, summary, text },
  };
}

/** POST the check run. Errors — including a missing checks:write scope — returned as data. */
export async function postCheckRun(
  client: GitHubClient,
  ref: RepoRef,
  request: CheckRunRequest,
): Promise<{ id: number; url: string } | { error: string }> {
  try {
    const res = await client.post<CheckRunResponse>(`/repos/${repoSlug(ref)}/check-runs`, request);
    return { id: res.data.id, url: res.data.html_url };
  } catch (err) {
    if (err instanceof GitHubError) {
      if (err.status === 403) {
        return { error: `${err.message} — the token needs the checks:write permission on ${repoSlug(ref)}` };
      }
      if (err.status === 404) {
        // check-runs 404s when the token can't see the repo or lacks the checks scope entirely.
        return { error: `${err.message} — check ${repoSlug(ref)} exists and the token can write checks to it` };
      }
      if (err.status === 422) {
        return { error: `${err.message} — GitHub rejected the check (is ${request.head_sha} pushed to ${repoSlug(ref)}?)` };
      }
      return { error: err.message };
    }
    return { error: `failed to publish check run: ${(err as Error).message}` };
  }
}
