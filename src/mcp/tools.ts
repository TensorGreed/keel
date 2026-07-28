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
import type { SqliteEventStore } from "../events/sqlite-store.js";

function normalize(repoRoot: string, input: string): string {
  const abs = path.isAbsolute(input) ? input : path.resolve(repoRoot, input);
  return path.relative(repoRoot, abs).split(path.sep).join(path.posix.sep);
}

function json(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function registerTools(server: McpServer, repoRoot: string, store?: SqliteEventStore): void {
  if (store) {
    registerWhy(server, repoRoot, store);
    registerVerdict(server, repoRoot, store);
  }

  server.tool(
    "get_dependencies",
    "Dependency report for a source file in the repo: what it imports, what imports it, " +
      "the full transitive blast radius of changing it, and symbol-level detail — the " +
      "file's exports, which symbols it imports from each dependency (importsFrom), and " +
      "which of its exports each dependent actually uses (usedBy; 'default' = default " +
      "export, '*' = whole module). Deterministic, built from static analysis — no guesses.",
    { file: z.string().describe("Path to a source file, relative to the repo root") },
    async ({ file }) => {
      try {
        const rel = normalize(repoRoot, file);
        if (!fs.existsSync(path.join(repoRoot, rel))) {
          return json({ error: `File not found in repo: ${rel}` });
        }
        const { graph } = await loadGraph(repoRoot);
        const report = reportFor(graph, rel);
        return json({
          ...report,
          blastRadius: report.transitiveDependents.length,
          filesScanned: graph.files.length,
        });
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
        return json(await getImpact(repoRoot, diff !== undefined ? { diff } : {}));
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

/** Registered only when an event store is available (needs mined/human decisions to read). */
function registerWhy(server: McpServer, repoRoot: string, store: SqliteEventStore): void {
  server.tool(
    "why",
    "Answer 'why is this like this?' from mined + human-recorded decision records, with " +
      "source receipts (the PR that made the call, its author and date). Give a file path, a " +
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
