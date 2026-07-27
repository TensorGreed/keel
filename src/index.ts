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

const repoRoot = path.resolve(process.env["KEEL_REPO"] ?? process.cwd());

if (!fs.existsSync(path.join(repoRoot, ".git"))) {
  // Not fatal — get_dependencies still works — but say so on stderr (stdout is protocol).
  console.error(`[keel] warning: ${repoRoot} is not a git repo; get_history will fail`);
}

const server = new McpServer({ name: "keel", version: "0.0.1" });
registerTools(server, repoRoot);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[keel] serving ${repoRoot} over stdio`);
