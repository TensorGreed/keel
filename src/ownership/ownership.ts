/**
 * Ownership signal: who knows a file, from the event log. Authorship is the recency-weighted
 * share of commit + PR authorship per file — a recent author counts more than an ancient one.
 * Composes into a reviewer suggestion (who to ask about a change) and the verdict's
 * foreign-code warning. Deterministic ETL over events; no model calls.
 *
 * Automated authors (dependabot, renovate, github-actions, …) are excluded — a bot is never a
 * useful reviewer and shouldn't be counted as an owner.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SqliteEventStore } from "../events/sqlite-store.js";

const execFileAsync = promisify(execFile);

/** Half-life for recency weighting: authorship this old counts half as much. */
const DEFAULT_HALF_LIFE_DAYS = 180;
const DAY_MS = 86_400_000;

export interface AuthorShare {
  author: string;
  /** recency-weighted fraction of this file's authorship, in (0,1] */
  share: number;
  /** number of commit/PR events by this author on the file */
  events: number;
  /** ISO date of their most recent touch */
  lastActive: string;
}

export interface ReviewerSuggestion {
  reviewer: string;
  /** recency-weighted fraction of the considered files' authorship */
  share: number;
  /** the considered files this reviewer has authored */
  filesKnown: string[];
  reason: string;
  lastActive: string;
}

/** A conservative bot-author matcher: exact known bots, or the GitHub "[bot]" suffix. */
export function isBot(name: string): boolean {
  const n = name.toLowerCase();
  if (n.endsWith("[bot]") || n.endsWith("-bot") || n.endsWith(" bot")) return true;
  return /^(dependabot|renovate|greenkeeper|snyk|github-actions|semantic-release|allcontributors|imgbot|mergify|codecov|pyup)\b/.test(n);
}

/** Recency weight in (0,1]: 1 for a touch "now", halving every halfLife days. */
function recencyWeight(nowMs: number, dateIso: string, halfLifeDays: number): number {
  const ageDays = Math.max(0, (nowMs - Date.parse(dateIso)) / DAY_MS);
  return Math.pow(2, -ageDays / halfLifeDays);
}

/** Only commit + PR events carry authorship we trust for ownership. */
function isAuthorshipKind(kind: string): boolean {
  return kind === "commit" || kind === "pr";
}

/**
 * Recency-weighted authorship shares for a single file, highest share first. Bots and events
 * without an author are ignored; [] when nothing (human) has touched it.
 */
export async function authorShares(
  store: SqliteEventStore,
  file: string,
  nowMs: number,
  options: { halfLifeDays?: number; scan?: number } = {},
): Promise<AuthorShare[]> {
  const halfLife = options.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  const events = await store.byFile(file, options.scan ?? 500);

  const weight = new Map<string, number>();
  const counts = new Map<string, number>();
  const last = new Map<string, string>();
  for (const e of events) {
    if (!isAuthorshipKind(e.kind) || !e.actor || isBot(e.actor)) continue;
    weight.set(e.actor, (weight.get(e.actor) ?? 0) + recencyWeight(nowMs, e.occurredAt, halfLife));
    counts.set(e.actor, (counts.get(e.actor) ?? 0) + 1);
    if (!last.has(e.actor) || e.occurredAt > last.get(e.actor)!) last.set(e.actor, e.occurredAt);
  }

  const total = [...weight.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return [];
  return [...weight.entries()]
    .map(([author, w]) => ({ author, share: w / total, events: counts.get(author)!, lastActive: last.get(author)! }))
    .sort((a, b) => b.share - a.share || b.lastActive.localeCompare(a.lastActive) || a.author.localeCompare(b.author));
}

/**
 * Rank reviewers for a set of touched files by recency-weighted authorship across all of them.
 * `exclude` drops specific people (the change's own author/committer); bots are always dropped.
 */
export async function suggestReviewers(
  store: SqliteEventStore,
  files: string[],
  options: { nowMs: number; exclude?: Set<string>; halfLifeDays?: number; limit?: number },
): Promise<ReviewerSuggestion[]> {
  const halfLife = options.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  const exclude = options.exclude ?? new Set<string>();
  const agg = new Map<string, { score: number; files: Set<string>; last: string }>();

  for (const file of files) {
    for (const e of await store.byFile(file, 500)) {
      if (!isAuthorshipKind(e.kind) || !e.actor || isBot(e.actor) || exclude.has(e.actor)) continue;
      const a = agg.get(e.actor) ?? { score: 0, files: new Set<string>(), last: "" };
      a.score += recencyWeight(options.nowMs, e.occurredAt, halfLife);
      a.files.add(file);
      if (e.occurredAt > a.last) a.last = e.occurredAt;
      agg.set(e.actor, a);
    }
  }

  const total = [...agg.values()].reduce((s, a) => s + a.score, 0);
  const suggestions = [...agg.entries()].map(([reviewer, a]) => {
    const known = [...a.files].sort();
    const preview = known.slice(0, 3).join(", ") + (known.length > 3 ? ", …" : "");
    return {
      reviewer,
      share: total > 0 ? a.score / total : 0,
      filesKnown: known,
      reason: `authored ${known.length} of ${files.length} touched file(s): ${preview}`,
      lastActive: a.last,
    };
  });
  suggestions.sort((x, y) => y.share - x.share || y.lastActive.localeCompare(x.lastActive) || x.reviewer.localeCompare(y.reviewer));
  return options.limit && options.limit > 0 ? suggestions.slice(0, options.limit) : suggestions;
}

/** The person who'd commit a working-tree change: `git config user.name`. null if unset. */
export async function resolveCommitter(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["config", "user.name"], { cwd: repoRoot });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
