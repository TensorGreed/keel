/**
 * MCP tool definitions. Contract rules (see CLAUDE.md):
 * zod-validated input, structured JSON output, errors returned as { error } data.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildFileGraph, reportFor, type FileGraph } from "../graph/dependencies.js";
import { historyFor } from "../git/history.js";

interface GraphCache {
  graph: FileGraph;
  builtAt: number;
}

const GRAPH_TTL_MS = 30_000;
let cache: GraphCache | null = null;

function getGraph(repoRoot: string): FileGraph {
  if (!cache || Date.now() - cache.builtAt > GRAPH_TTL_MS) {
    cache = { graph: buildFileGraph(repoRoot), builtAt: Date.now() };
  }
  return cache.graph;
}

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
      "and the full transitive blast radius of changing it. Deterministic, built from " +
      "static analysis — no guesses.",
    { file: z.string().describe("Path to a source file, relative to the repo root") },
    async ({ file }) => {
      try {
        const rel = normalize(repoRoot, file);
        if (!fs.existsSync(path.join(repoRoot, rel))) {
          return json({ error: `File not found in repo: ${rel}` });
        }
        const graph = getGraph(repoRoot);
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
