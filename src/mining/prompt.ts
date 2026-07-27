/**
 * The decision-mining prompt. Deterministic given a thread, so it's testable without a
 * model. Instructions and the rendered thread go in one string (the DecisionModel interface
 * is text-in/text-out), keeping Ollama and Anthropic-Haiku on the same path.
 */

export interface ThreadReview {
  author: string | null;
  state: string;
  body: string;
}

export interface ThreadComment {
  author: string | null;
  path: string;
  inReplyTo: number | null;
  diffHunk: string;
  body: string;
}

export interface PrThread {
  number: number;
  title: string;
  body: string;
  author: string | null;
  state: string;
  merged: boolean;
  files: string[];
  reviews: ThreadReview[];
  comments: ThreadComment[];
}

const INSTRUCTIONS = `You extract engineering decisions from a pull request and its review discussion.

A "decision" is a deliberate technical choice with a rationale — an approach taken, a tradeoff made, a design constraint honored, an alternative rejected. Routine changes (typo fixes, dependency bumps, formatting, trivial renames) carry no decision.

Read the PR below and respond with ONLY a JSON object, no prose, no code fences, with exactly these fields:
{
  "hasDecision": boolean,   // false if the PR carries no notable decision
  "summary": string,        // one sentence: what was decided (empty if hasDecision is false)
  "rationale": string,      // why, grounded in the PR/discussion (empty if none)
  "alternatives": string[], // options considered or rejected, if any
  "files": string[],        // repo-relative paths the decision most concerns
  "confidence": "high" | "medium" | "low"
}

Be faithful to the text — do not invent rationale that isn't supported by the PR or its comments. Prefer "low" confidence when the reasoning is implicit. If there is no real decision, set hasDecision to false and leave summary/rationale empty.`;

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

/** Render a PR thread into the extraction prompt. */
export function buildDecisionPrompt(thread: PrThread): string {
  const parts: string[] = [INSTRUCTIONS, "", "--- PULL REQUEST ---"];
  parts.push(`#${thread.number}: ${thread.title}`);
  parts.push(`Author: ${thread.author ?? "unknown"} | State: ${thread.state}${thread.merged ? " (merged)" : ""}`);
  if (thread.files.length > 0) parts.push(`Files: ${thread.files.join(", ")}`);
  if (thread.body.trim() !== "") {
    parts.push("", "Description:", truncate(thread.body.trim(), 4000));
  }

  if (thread.reviews.length > 0) {
    parts.push("", "Reviews:");
    for (const review of thread.reviews) {
      const body = review.body.trim();
      parts.push(`- ${review.author ?? "unknown"} [${review.state}]${body ? `: ${truncate(body, 1000)}` : ""}`);
    }
  }

  if (thread.comments.length > 0) {
    parts.push("", "Review comments (thread):");
    for (const comment of thread.comments) {
      const reply = comment.inReplyTo !== null ? " (reply)" : "";
      parts.push(`- ${comment.author ?? "unknown"} on ${comment.path}${reply}:`);
      if (comment.diffHunk.trim() !== "") parts.push(`  code: ${truncate(comment.diffHunk.trim(), 400)}`);
      parts.push(`  ${truncate(comment.body.trim(), 1000)}`);
    }
  }

  parts.push("", "--- END PULL REQUEST ---", "", "Respond with only the JSON object.");
  return parts.join("\n");
}
