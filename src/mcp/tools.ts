/**
 * MCP tool definitions. Contract rules (see CLAUDE.md):
 * zod-validated input, structured JSON output, errors returned as { error } data.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { reportFor } from "../graph/dependencies.js";
import { loadGraph, loadHeadGraph } from "../graph/cache.js";
import { getImpact } from "../simulate/impact.js";
import { changedRoots, selectTests } from "../simulate/select-tests.js";
import { preflight } from "../simulate/preflight.js";
import { historyFor } from "../git/history.js";
import { answerWhy } from "../retrieval/why.js";
import { OllamaEmbeddingModel } from "../retrieval/embed.js";
import { resolveRepoRef } from "../github/remote.js";
import { computeVerdict } from "../trust/verdict.js";
import { buildContext } from "../context/briefing.js";
import { computeHotspots, coveredFiles } from "../trust/hotspots.js";
import { loadPolicy, DEFAULT_POLICY } from "../trust/policy.js";
import { authorShares, resolveCommitter, suggestReviewers } from "../ownership/ownership.js";
import { detectFlakyTests } from "../ci/flaky.js";
import { findWorkspaceConfig, loadWorkspaceConfig } from "../workspace/config.js";
import { buildWorkspaceGraph, memberOf, qualify, workspaceBlastRadius } from "../workspace/graph.js";
import type { SqliteEventStore } from "../events/sqlite-store.js";

function normalize(repoRoot: string, input: string): string {
  const abs = path.isAbsolute(input) ? input : path.resolve(repoRoot, input);
  return path.relative(repoRoot, abs).split(path.sep).join(path.posix.sep);
}

function json(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/**
 * How many non-suppressed decision records are linked to any of `files`. Cheap: one byKind read,
 * then a membership check (a repo has far fewer decisions than a blast radius has files). This is
 * the signal for the "call why" nudge appended to get_dependencies / get_impact — so recorded
 * decisions surface even when the agent read the code and never thought to ask.
 */
async function countLinkedDecisions(store: SqliteEventStore, files: Set<string>): Promise<number> {
  if (files.size === 0) return 0;
  const suppressed = store.suppressedDecisions();
  let count = 0;
  for (const decision of await store.byKind("decision", 100_000)) {
    if (decision.externalId !== undefined && suppressed.has(decision.externalId)) continue;
    if ((decision.files ?? []).some((f) => files.has(f))) count++;
  }
  return count;
}

const decisionsNotice = (n: number): string =>
  `${n} recorded decision(s) touch these files — call \`why\` for details before removing, reverting, or simplifying their current behavior.`;

export function registerTools(server: McpServer, repoRoot: string, store?: SqliteEventStore): void {
  if (store) {
    registerWhy(server, repoRoot, store);
    registerVerdict(server, repoRoot, store);
    registerContext(server, repoRoot, store);
    registerSuggestReviewers(server, repoRoot, store);
    registerFlakyTests(server, store);
  }

  // Cross-repo tool: only when this repo is part of a workspace (keel.workspace.json at/above it).
  if (findWorkspaceConfig(repoRoot)) registerWorkspaceImpact(server, repoRoot);

  server.tool(
    "get_dependencies",
    "Dependency report for a source file in the repo: what it imports, what imports it, " +
      "the full transitive blast radius of changing it, and symbol-level detail — the " +
      "file's exports, which symbols it imports from each dependency (importsFrom), and " +
      "which of its exports each dependent actually uses (usedBy; 'default' = default " +
      "export, '*' = whole module). Each dependency/dependent is also given with its edge " +
      "provenance in `edges`/`dependentEdges` as { file, kind }: 'import' is a real directed " +
      "import; 'package' is same-package unit adjacency (Java/Go treat a package as one unit — " +
      "this edge is inherently mutual and shows symbol '*' both ways, so it is expected, not an " +
      "analyzer bug); 'di' is Spring dependency-injection wiring (an injector to the bean that " +
      "satisfies it, e.g. an interface's implementation). Deterministic static analysis — no guesses.",
    { file: z.string().describe("Path to a source file, relative to the repo root") },
    async ({ file }) => {
      try {
        const rel = normalize(repoRoot, file);
        if (!fs.existsSync(path.join(repoRoot, rel))) {
          return json({ error: `File not found in repo: ${rel}` });
        }
        const { graph } = await loadGraph(repoRoot);
        const report = reportFor(graph, rel);
        const out: Record<string, unknown> = {
          ...report,
          blastRadius: report.transitiveDependents.length,
          filesScanned: graph.files.length,
        };
        // Surface recorded decisions on this file or its direct neighbors, even if unasked.
        if (store) {
          const n = await countLinkedDecisions(store, new Set([rel, ...report.dependencies, ...report.dependents]));
          if (n > 0) out["decisionsNotice"] = decisionsNotice(n);
        }
        return json(out);
      } catch (err) {
        return json({ error: `get_dependencies failed: ${(err as Error).message}` });
      }
    },
  );

  server.tool(
    "get_impact",
    "Map a change to its impacted subgraph: given a unified diff (or, if omitted, the " +
      "working tree's uncommitted changes vs HEAD), return the changed files and touched " +
      "exported symbols, the file-level blast radius (impactedFiles), a symbol-narrowed " +
      "subset (impactedNarrowed — a dependent is dropped only when the change provably " +
      "can't reach an export it uses), and the shortest dependency path from each impacted " +
      "file back to a changed one. Deterministic static analysis over the graph — the " +
      "scoping step before test selection. Renames/deletes/new files handled explicitly.",
    { diff: z.string().optional().describe("Unified diff; omit to use uncommitted working-tree changes") },
    async ({ diff }) => {
      try {
        const result = await getImpact(repoRoot, diff !== undefined ? { diff } : {});
        // Surface recorded decisions on any changed or impacted file, even if unasked.
        if (store && !("error" in result)) {
          const files = new Set<string>([...result.changedFiles.map((c) => c.path), ...result.impactedFiles]);
          const n = await countLinkedDecisions(store, files);
          if (n > 0) return json({ ...result, decisionsNotice: decisionsNotice(n) });
        }
        return json(result);
      } catch (err) {
        return json({ error: `get_impact failed: ${(err as Error).message}` });
      }
    },
  );

  server.tool(
    "select_tests",
    "Select the test files to run for a change: given a unified diff (or, if omitted, the " +
      "working tree's uncommitted changes vs HEAD), return the test files that transitively " +
      "import any changed source file, what each covers, the shortest import path from test " +
      "to changed file, and uncoveredChanges — changed source files no test reaches. " +
      "Import-reachability coverage (a safe overapproximation), the scoping step the " +
      "sandbox runner will execute. Deterministic; no tests are run.",
    { diff: z.string().optional().describe("Unified diff; omit to use uncommitted working-tree changes") },
    async ({ diff }) => {
      try {
        const impact = await getImpact(repoRoot, diff !== undefined ? { diff } : {});
        if ("error" in impact) return json(impact);
        const { graph } = await loadHeadGraph(repoRoot);
        return json(selectTests(graph, changedRoots(impact.changedFiles)));
      } catch (err) {
        return json({ error: `select_tests failed: ${(err as Error).message}` });
      }
    },
  );

  server.tool(
    "preflight",
    "Flight-simulate a change: map a unified diff (or, if omitted, the working tree's " +
      "uncommitted changes) to its impacted files, select the covering tests, apply the " +
      "diff in an isolated git worktree, and run those tests — returning EXECUTED results, " +
      "not predictions. Output: { impacted, testsSelected, uncoveredChanges, executed " +
      "{ status, passed, failed, failures[{ test, file, message, trace, graphPath }] }, budget }. " +
      "Hard-capped by maxTests (default 50) and maxSeconds (default 120), always reported; " +
      "over the cap, tests nearest the change run first. Errors (bad diff, apply-failed, " +
      "timeout) come back as data in status, never thrown.",
    {
      diff: z.string().optional().describe("Unified diff; omit to use uncommitted working-tree changes"),
      maxTests: z.number().int().min(0).optional().describe("Max test files to run (default 50 / KEEL_MAX_TESTS)"),
      maxSeconds: z.number().int().min(1).optional().describe("Wall-time cap in seconds (default 120 / KEEL_MAX_SECONDS)"),
    },
    async ({ diff, maxTests, maxSeconds }) => {
      try {
        return json(
          await preflight(repoRoot, {
            ...(diff !== undefined ? { diff } : {}),
            ...(maxTests !== undefined ? { maxTests } : {}),
            ...(maxSeconds !== undefined ? { maxSeconds } : {}),
          }),
        );
      } catch (err) {
        return json({ error: `preflight failed: ${(err as Error).message}` });
      }
    },
  );

  server.tool(
    "upgrade_scope",
    "Scope a dependency upgrade and PROVE what it breaks. Finds every file importing the package " +
      "(from the graph's retained external import specifiers), computes the union blast radius and " +
      "the covering tests, then — in a throwaway git worktree, never the user's checkout — applies " +
      "ONLY the version bump, runs `npm install`, and executes those tests. Output: { scope " +
      "{ importSites, specifiers, surface, shareOfRepo, testsSelected, uncoveredSurface }, install " +
      "{ ok, signals[{ kind, message, evidence }] }, executed { status, failures[{ test, file, " +
      "message, trace, graphPath, importSite }], discountedFlaky[] }, memory { pins[], pastRepairs[] }, " +
      "nextSteps, reportOnly, verdict, budget }. `memory` is what the team already RECORDED about " +
      "this dependency — a pin with a reason is a decision the upgrade may be reversing, and it is " +
      "listed first in nextSteps with its receipt; keel surfaces it but does not judge whether it " +
      "forbids the upgrade. Install-time problems (peer-dependency conflicts, engine mismatches) are " +
      "reported as breaks in their own right. Failures CI has proven flaky are separated into " +
      "discountedFlaky rather than hidden. REPORT ONLY: keel attempts no repairs — every failure " +
      "is a work item for YOU to fix. Pass scopeOnly for the graph answer alone (no install, no " +
      "network, fast). Errors come back as data, never thrown.",
    {
      package: z.string().describe("Package name, e.g. `lodash` or `@scope/pkg`"),
      version: z.string().optional().describe("Target version, range, or dist-tag (default `latest`)"),
      scopeOnly: z.boolean().optional().describe("Skip the install and tests; report the graph surface only"),
      maxTests: z.number().int().min(0).optional().describe("Max covering tests to run (default 50 / KEEL_MAX_TESTS)"),
      maxSeconds: z.number().int().min(1).optional().describe("Wall-time cap for install + tests (default 300 / KEEL_MAX_SECONDS)"),
    },
    async ({ package: pkg, version, scopeOnly, maxTests, maxSeconds }) => {
      try {
        const { runUpgradeAnalysis } = await import("../upgrade/upgrade.js");
        return json(
          await runUpgradeAnalysis(repoRoot, `${pkg}@${version ?? "latest"}`, {
            ...(scopeOnly !== undefined ? { scopeOnly } : {}),
            ...(maxTests !== undefined ? { maxTests } : {}),
            ...(maxSeconds !== undefined ? { maxSeconds } : {}),
            ...(store ? { store } : {}),
          }),
        );
      } catch (err) {
        return json({ error: `upgrade_scope failed: ${(err as Error).message}` });
      }
    },
  );

  server.tool(
    "upgrade_repair",
    "One turn of an upgrade repair loop. YOU write the fix — keel scopes, executes and judges it " +
      "(it makes no model calls). Call with no patch to get the first break; keel applies the " +
      "version bump in a throwaway worktree, installs, runs the covering tests, and returns ONE " +
      "task with everything needed to fix it: the failing test and trace, the import site and its " +
      "source, which of the package's exports that file actually uses, and the package's own " +
      "account of the change (its CHANGELOG sliced between the two versions, plus a real diff of " +
      "its manifest and entry file). Write a unified diff against HEAD, send it back as `patch` " +
      "with `attempt` incremented, and keel re-runs — now also running the tests covering whatever " +
      "your patch touched, so a fix outside the original surface still has to be proven. Repeat " +
      "until status is `green`. Stateless: YOU hold the accumulated patch, so pass the whole diff " +
      "each time. Statuses: green (done), work (task attached), exhausted (attempts spent — stop " +
      "and escalate), blocked (nothing could be proven, e.g. the patch doesn't apply). An " +
      "install-time break (peer conflict, engine mismatch) is a `manifest` task and comes first: " +
      "until it's fixed the tests ran against a tree the package didn't ask for. Every task also " +
      "carries `pins` (recorded decisions that may bear on this upgrade — READ THESE BEFORE writing " +
      "a fix; you may be reversing a deliberate pin) and `pastRepairs` (how this package was " +
      "migrated here before, patch included). On green, keel records the patch as team memory so the " +
      "next upgrade of this package starts from it.",
    {
      package: z.string().describe("Package name, e.g. `lodash` or `@scope/pkg`"),
      version: z.string().optional().describe("Target version, range, or dist-tag (default `latest`)"),
      patch: z.string().optional().describe("Your accumulated repair: a unified diff against HEAD. Omit on the first call"),
      attempt: z.number().int().min(1).optional().describe("Which attempt this is (default 1)"),
      maxAttempts: z.number().int().min(1).optional().describe("Stop issuing tasks past this many attempts (default 10)"),
      maxTests: z.number().int().min(0).optional().describe("Cap the tests run per attempt (default 50)"),
      maxSeconds: z.number().int().min(1).optional().describe("Wall-time cap for install + tests (default 300)"),
    },
    async ({ package: pkg, version, patch, attempt, maxAttempts, maxTests, maxSeconds }) => {
      try {
        const { runRepairStep } = await import("../upgrade/repair.js");
        return json(
          await runRepairStep(repoRoot, `${pkg}@${version ?? "latest"}`, {
            ...(patch !== undefined ? { patch } : {}),
            ...(attempt !== undefined ? { attempt } : {}),
            ...(maxAttempts !== undefined ? { maxAttempts } : {}),
            ...(maxTests !== undefined ? { maxTests } : {}),
            ...(maxSeconds !== undefined ? { maxSeconds } : {}),
            ...(store ? { store } : {}),
          }),
        );
      } catch (err) {
        return json({ error: `upgrade_repair failed: ${(err as Error).message}` });
      }
    },
  );

  server.tool(
    "upgrade_batch",
    "Analyse MANY dependency upgrades in one pass and classify each against `keel.policy.json`. " +
      "Every target is scoped from the graph first (cheap, no install), ranked by a risk score " +
      "combining how much of the repo it reaches, how much of that reach no test proves, how far " +
      "the version moves, and whether a recorded decision mentions it. They then execute SAFEST " +
      "FIRST against one shared wall-clock budget, so a batch that runs out of time has completed " +
      "the upgrades most likely to be mergeable. Outcomes: `pinned` (policy forbids it, not " +
      "executed, reason given), `auto-merge` (green, fully covered, and the policy opted in), " +
      "`needs-review`, `blocked`, and `not-run` (the budget ran out — this is NOT a clean result, " +
      "and it is reported rather than hidden). Each executed entry carries a PR proposal: branch, " +
      "title, a markdown body containing the executed proof, an applicable manifest patch, and the " +
      "commands to open it. Keel composes those and NEVER pushes a branch or opens a PR — pushing " +
      "under someone's credentials is not keel's to assume. Errors come back as data.",
    {
      targets: z.array(z.string()).min(1).describe("Upgrade targets, e.g. [\"lodash@4.17.21\", \"zod@3.23.0\"]"),
      maxSeconds: z.number().int().min(1).optional().describe("Wall-clock budget for the WHOLE batch (default 1800)"),
      maxSecondsPerPackage: z.number().int().min(1).optional().describe("Per-package cap inside the batch (default 300)"),
      maxTestsPerPackage: z.number().int().min(0).optional().describe("Cap the tests run per package (default 50)"),
    },
    async ({ targets, maxSeconds, maxSecondsPerPackage, maxTestsPerPackage }) => {
      try {
        const { runUpgradeBatch } = await import("../upgrade/batch.js");
        return json(
          await runUpgradeBatch(repoRoot, targets, {
            ...(maxSeconds !== undefined ? { maxSeconds } : {}),
            ...(maxSecondsPerPackage !== undefined ? { maxSecondsPerPackage } : {}),
            ...(maxTestsPerPackage !== undefined ? { maxTestsPerPackage } : {}),
            ...(store ? { store } : {}),
          }),
        );
      } catch (err) {
        return json({ error: `upgrade_batch failed: ${(err as Error).message}` });
      }
    },
  );

  server.tool(
    "get_history",
    "Recent git history for a file or directory: who changed it, when, and why " +
      "(commit subjects and bodies). The raw material for 'why is this like this?'.",
    {
      path: z.string().describe("Path to a file or directory, relative to the repo root"),
      limit: z.number().int().min(1).max(100).default(20).describe("Max commits to return"),
    },
    async ({ path: target, limit }) => {
      try {
        const rel = normalize(repoRoot, target);
        const commits = await historyFor(repoRoot, rel, limit);
        return json({ path: rel, commits });
      } catch (err) {
        return json({ error: `get_history failed: ${(err as Error).message}` });
      }
    },
  );
}

/** Query-time embedding timeout: keep the server responsive if Ollama is slow/absent. */
const WHY_EMBED_TIMEOUT_MS = 2000;

/** Hotspot window + top-N used to flag a context candidate as a repo risk hotspot. */
const HOTSPOT_WINDOW_DAYS = 90;
const HOTSPOT_TOP_N = 20;

/** Registered only when an event store is available (needs mined/human decisions to read). */
function registerWhy(server: McpServer, repoRoot: string, store: SqliteEventStore): void {
  server.tool(
    "why",
    "Answer 'why is this like this?' from mined + human-recorded decision records, with " +
      "source receipts (the PR that made the call, its author and date). " +
      "CALL THIS BEFORE agreeing to any change that removes, reverts, or simplifies existing " +
      "behavior — the code's current shape may be a recorded decision, and endorsing its reversal " +
      "without checking is how teams relearn old lessons. " +
      "Give a file path, a " +
      "question, or both (both = decisions linked to the file, ranked by the question). " +
      "Each decision carries its origin (mined | human — human overrides win), why it matched " +
      "(direct / dependency / dependent graph link, or semantic / keyword), and its source. " +
      "Semantic search uses a LOCAL embedding model and falls back to keyword match if none is " +
      "reachable — never fails. Populate the index with `keel ingest` then `keel mine`.",
    {
      path: z.string().optional().describe("A source file to find decisions about (relative to repo root)"),
      question: z.string().optional().describe("A natural-language question to search decisions by"),
    },
    async ({ path: filePath, question }) => {
      try {
        if (filePath === undefined && question === undefined) {
          return json({ error: "why needs a path, a question, or both" });
        }
        const { graph } = await loadHeadGraph(repoRoot);
        const ref = await resolveRepoRef(repoRoot);
        const embedModel = new OllamaEmbeddingModel(
          process.env["KEEL_EMBED_MODEL"],
          process.env["KEEL_OLLAMA_URL"],
          WHY_EMBED_TIMEOUT_MS,
        );
        const result = await answerWhy(
          store,
          {
            ...(filePath !== undefined ? { path: normalize(repoRoot, filePath) } : {}),
            ...(question !== undefined ? { question } : {}),
          },
          { graph, embedModel, repoRef: "error" in ref ? null : ref },
        );
        return json(result);
      } catch (err) {
        return json({ error: `why failed: ${(err as Error).message}` });
      }
    },
  );
}

/** One-call task briefing: candidate files, blast radius, tests, decisions, and risks. */
function registerContext(server: McpServer, repoRoot: string, store: SqliteEventStore): void {
  server.tool(
    "context",
    "Brief a coding task before touching it: given a free-text task (and optionally files you " +
      "already know are involved), resolve the candidate files and, for each, return its blast " +
      "radius + key dependents, recent history, linked decisions (with PR receipts), and covering " +
      "tests. CALL THIS BEFORE starting work — and especially before agreeing to any change that " +
      "removes, reverts, or simplifies existing behavior — the code's current shape may be a " +
      "recorded decision (surfaced here in relevantDecisions), and endorsing its reversal without " +
      "checking is how teams relearn old lessons. " +
      "Rolls up suggestedTests, relevantDecisions (human-recorded first), and risks " +
      "(uncovered / high-blast-radius / protected-path / top-hotspot). Pure composition of the " +
      "graph, git, the event log, the decision index, and keel.policy.json — no generative calls; " +
      "ranking uses the same LOCAL embedding as `why` and falls back to keyword. Capped to the " +
      "top N candidates (default 8); everything truncated is stated in notes.",
    {
      task: z.string().describe("Free-text description of what you're about to do"),
      files: z.array(z.string()).optional().describe("Paths you already know are involved (relative to repo root)"),
      topN: z.number().int().min(1).max(50).optional().describe("Max candidate files to brief, by relevance (default 8)"),
    },
    async ({ task, files, topN }) => {
      try {
        const { graph } = await loadHeadGraph(repoRoot);
        const ref = await resolveRepoRef(repoRoot);
        const loaded = loadPolicy(repoRoot);
        const policy = "error" in loaded ? DEFAULT_POLICY : loaded.policy;
        const embedModel = new OllamaEmbeddingModel(
          process.env["KEEL_EMBED_MODEL"],
          process.env["KEEL_OLLAMA_URL"],
          WHY_EMBED_TIMEOUT_MS,
        );
        // Repo risk hotspots (churn × blast radius × coverage gap) so a candidate that's one
        // gets flagged. Commit churn comes from the event log the server already ingested.
        const since = new Date(Date.now() - HOTSPOT_WINDOW_DAYS * 86_400_000).toISOString();
        const hotspots = new Set(
          computeHotspots(graph, store.churnByFile(since), coveredFiles(graph), { limit: HOTSPOT_TOP_N }).map((h) => h.path),
        );
        const result = await buildContext(
          {
            task,
            ...(files !== undefined ? { files: files.map((f) => normalize(repoRoot, f)) } : {}),
            ...(topN !== undefined ? { topN } : {}),
          },
          {
            graph,
            store,
            embedModel,
            repoRef: "error" in ref ? null : ref,
            policy,
            history: (file) => historyFor(repoRoot, file, 5),
            hotspots,
            owners: (file) => authorShares(store, file, Date.now()),
          },
        );
        if ("error" in loaded && !("error" in result)) {
          result.notes.push(`keel.policy.json ignored for risk flags (${loaded.error}); used defaults.`);
        }
        return json(result);
      } catch (err) {
        return json({ error: `context failed: ${(err as Error).message}` });
      }
    },
  );
}

/** Suggest reviewers for a change from recency-weighted authorship of its files. */
function registerSuggestReviewers(server: McpServer, repoRoot: string, store: SqliteEventStore): void {
  server.tool(
    "suggest_reviewers",
    "Suggest who should review a change, ranked by recency-weighted authorship of the files it " +
      "touches (changed + impacted), from the event log's commit + PR history. Give a unified diff " +
      "or omit to use the working tree. Each suggestion says which of the touched files the person " +
      "knows and their authorship share. Excludes bots (dependabot etc.), an optional `author`, and " +
      "the change's committer (git user.name) when determinable. Deterministic; no model calls. " +
      "Needs ingested history (`keel serve` ingests commits; `keel ingest` adds PR authors).",
    {
      diff: z.string().optional().describe("Unified diff; omit to use uncommitted working-tree changes"),
      author: z.string().optional().describe("An author to exclude from suggestions (e.g. the change's author)"),
      limit: z.number().int().min(1).max(50).optional().describe("Max reviewers to suggest (default 5)"),
    },
    async ({ diff, author, limit }) => {
      try {
        const impact = await getImpact(repoRoot, diff !== undefined ? { diff } : {});
        if ("error" in impact) return json(impact);

        const changed = changedRoots(impact.changedFiles);
        const files = [...new Set([...changed, ...impact.impactedFiles])].slice(0, 200);

        const exclude = new Set<string>();
        if (author) exclude.add(author);
        const committer = await resolveCommitter(repoRoot);
        if (committer) exclude.add(committer);

        const reviewers = await suggestReviewers(store, files, {
          nowMs: Date.now(),
          exclude,
          limit: limit ?? 5,
        });

        const notes: string[] = [];
        if (files.length === 0) notes.push("The change touches no graph files, so there's nothing to attribute.");
        else if (reviewers.length === 0) {
          notes.push(
            store.count("commit") === 0
              ? "No commit history ingested yet — run `keel serve` (or `keel ingest` for PR authors)."
              : "No human authors found for the touched files (new files, or only excluded authors/bots).",
          );
        }
        return json({ reviewers, filesConsidered: files.length, excluded: [...exclude], notes });
      } catch (err) {
        return json({ error: `suggest_reviewers failed: ${(err as Error).message}` });
      }
    },
  );
}

/** List tests CI has proven flaky (passed and failed on the same commit), with evidence. */
function registerFlakyTests(server: McpServer, store: SqliteEventStore): void {
  server.tool(
    "flaky_tests",
    "List tests known to be flaky from ingested CI runs: tests that both passed AND failed on the " +
      "same commit (non-deterministic) — the one signal that can't be a real regression or fix. " +
      "Each entry names the test, its file, how many commits it flipped on, and pass/fail counts. " +
      "The verdict uses this to discount a flaky failure instead of blocking on it. Deterministic " +
      "aggregation over the event log, no model calls. Populate it with `keel ci <junit.xml>`.",
    {},
    async () => {
      try {
        const runs = await store.byKind("ci_run", 300);
        const flaky = detectFlakyTests(runs);
        const notes: string[] = [];
        if (runs.length === 0) notes.push("No CI runs ingested yet — run `keel ci <junit-report.xml>` after your test job.");
        else if (flaky.length === 0) {
          notes.push(
            `Analyzed ${runs.length} CI run(s); no flaky tests found. Detection needs the same commit run more than once (retries, matrix, re-runs) to observe a flip.`,
          );
        }
        return json({ flaky, runsAnalyzed: runs.length, notes });
      } catch (err) {
        return json({ error: `flaky_tests failed: ${(err as Error).message}` });
      }
    },
  );
}

/** Machine-checkable pass/warn/block verdict over the change, against keel.policy.json. */
function registerVerdict(server: McpServer, repoRoot: string, store: SqliteEventStore): void {
  server.tool(
    "verdict",
    "A machine-checkable pass | warn | block on a change, for a CI check or an agent to gate " +
      "on. Composes existing facts — blast radius, the executed sim (preflight), uncovered " +
      "changes, and decisions the change may affect — and evaluates them against keel.policy.json " +
      "at the repo root (conservative defaults if absent). Every reason names its rule and the " +
      "exact fact that triggered it. Pure policy evaluation, no model calls. Give a unified diff, " +
      "or omit to use the working tree. Sim errors (apply-failed/timed-out) block, returned as data.",
    {
      diff: z.string().optional().describe("Unified diff to judge; omit to use uncommitted working-tree changes"),
      maxTests: z.number().int().min(0).optional().describe("Cap on tests the sim runs (default 50 / KEEL_MAX_TESTS)"),
      maxSeconds: z.number().int().min(1).optional().describe("Sim wall-time cap in seconds (default 120 / KEEL_MAX_SECONDS)"),
    },
    async ({ diff, maxTests, maxSeconds }) => {
      try {
        return json(
          await computeVerdict(repoRoot, store, {
            ...(diff !== undefined ? { diff } : {}),
            ...(maxTests !== undefined ? { maxTests } : {}),
            ...(maxSeconds !== undefined ? { maxSeconds } : {}),
          }),
        );
      } catch (err) {
        return json({ error: `verdict failed: ${(err as Error).message}` });
      }
    },
  );
}

/** Registered only when this repo is part of a workspace (keel.workspace.json at/above KEEL_REPO). */
function registerWorkspaceImpact(server: McpServer, repoRoot: string): void {
  server.tool(
    "workspace_impact",
    "Cross-repo blast radius: given a file, return every file across ALL repos in the workspace " +
      "(keel.workspace.json) that transitively depends on it — grouped by repo — plus the cross-repo " +
      "import edges on those paths. This is how you see that changing a shared library reaches the " +
      "services in OTHER repos that import its published package (TS by package.json name, Python/Go " +
      "by the sibling's own resolver). Files are addressed as <repo>::<path>; a bare path is taken to " +
      "be in the current repo (KEEL_REPO). Deterministic static analysis, no guesses. NOTE: this is " +
      "the graph/impact layer only — keel's EXECUTION (preflight, verdict) stays single-repo, so a " +
      "cross-repo dependent is a candidate to check by hand, not an executed test result.",
    { file: z.string().describe("A file as <repo>::<path>, or a bare path in the current repo (KEEL_REPO)") },
    async ({ file }) => {
      try {
        const cfg = loadWorkspaceConfig(repoRoot);
        if ("error" in cfg) return json({ error: cfg.error });
        const graph = await buildWorkspaceGraph(cfg);

        // Qualify the input: a bare path is assumed to live in the current repo (a workspace member).
        let qualified = file;
        if (!file.includes("::")) {
          const here = cfg.members.find((m) => m.root === path.resolve(repoRoot));
          if (!here) {
            return json({ error: `${repoRoot} is not a member of ${cfg.file}; address the file as <repo>::<path>` });
          }
          qualified = qualify(here.name, normalize(repoRoot, file));
        }
        if (!graph.files.includes(qualified)) {
          return json({ error: `"${qualified}" is not a workspace file (address it as <repo>::<path>; see \`keel workspace\`)` });
        }

        const radius = workspaceBlastRadius(graph, qualified);
        const impacted = new Set([qualified, ...radius]);
        const byRepo: Record<string, string[]> = {};
        for (const f of radius) (byRepo[memberOf(f)] ??= []).push(f);
        for (const list of Object.values(byRepo)) list.sort();

        return json({
          file: qualified,
          repo: memberOf(qualified),
          blastRadius: radius.length,
          crossRepoDependents: radius.filter((f) => memberOf(f) !== memberOf(qualified)).length,
          byRepo,
          // the cross-repo edges that carry the impact across a boundary (both endpoints impacted)
          crossEdges: graph.crossEdges.filter((e) => impacted.has(e.from) && impacted.has(e.to)),
          members: graph.members.map((m) => m.name),
          // the graph reflects the CHECKOUTS, not the versions resolved at runtime — flag any skew
          ...(graph.warnings.length > 0 ? { warnings: graph.warnings } : {}),
        });
      } catch (err) {
        return json({ error: `workspace_impact failed: ${(err as Error).message}` });
      }
    },
  );
}
