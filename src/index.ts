#!/usr/bin/env node
/**
 * Keel — development intelligence layer, delivered as an MCP server over stdio.
 *
 * Usage: KEEL_REPO=/path/to/repo keel        (defaults to cwd)
 *
 * Register in a project's .mcp.json:
 *   { "mcpServers": { "keel": { "command": "keel", "env": { "KEEL_REPO": "." } } } }
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./mcp/tools.js";
import { SqliteEventStore } from "./events/sqlite-store.js";
import { ingestCommits } from "./events/ingest.js";

const repoRoot = path.resolve(process.env["KEEL_REPO"] ?? process.cwd());

if (!fs.existsSync(path.join(repoRoot, ".git"))) {
  // Not fatal — get_dependencies still works — but say so on stderr (stdout is protocol).
  console.error(`[keel] warning: ${repoRoot} is not a git repo; get_history will fail`);
}

// Substrate: persist the event log and ingest commits before serving. The store isn't
// wired into a tool yet — Phase 1 simulation and Phase 2 PR events write into it — but
// ingestion runs now so the timeline is populated. Failures here are non-fatal: the
// graph/history tools work without it.
const store = new SqliteEventStore(path.join(repoRoot, ".keel", "events.db"));
try {
  await ingestCommits(store, repoRoot);
} catch (err) {
  console.error(`[keel] commit ingestion failed: ${(err as Error).message}`);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    store.close();
    process.exit(0);
  });
}

const server = new McpServer({ name: "keel", version: "0.0.1" });
registerTools(server, repoRoot);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[keel] serving ${repoRoot} over stdio`);
