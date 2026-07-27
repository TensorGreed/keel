/**
 * MCP tool definitions. Contract rules (see CLAUDE.md):
 * zod-validated input, structured JSON output, errors returned as { error } data.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { reportFor } from "../graph/dependencies.js";
import { loadGraph } from "../graph/cache.js";
import { getImpact } from "../simulate/impact.js";
import { historyFor } from "../git/history.js";

function normalize(repoRoot: string, input: string): string {
  const abs = path.isAbsolute(input) ? input : path.resolve(repoRoot, input);
  return path.relative(repoRoot, abs).split(path.sep).join(path.posix.sep);
}

function json(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function registerTools(server: McpServer, repoRoot: string): void {
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
