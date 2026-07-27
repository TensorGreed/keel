/**
 * `keel init` — register the Keel MCP server in a project's .mcp.json.
 *
 * Merges into any existing config (other servers are preserved), is idempotent (a second
 * run reports no change), and never overwrites a file it can't parse. Failures are
 * returned as data, per CLAUDE.md — the CLI wrapper turns them into messages.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const CONFIG_FILE = ".mcp.json";
const DEFAULT_SERVER_NAME = "keel";
const DEFAULT_COMMAND = "keel";

export interface McpServerEntry {
  command: string;
  env: Record<string, string>;
}

export interface InitOptions {
  /** directory whose .mcp.json to write (the project root) */
  dir: string;
  /** key under mcpServers (default "keel") */
  serverName?: string;
  /** executable that launches keel (default "keel"; must be on PATH for the client) */
  command?: string;
}

export interface InitResult {
  path: string;
  action: "created" | "updated" | "unchanged";
  serverName: string;
  entry: McpServerEntry;
}

interface McpConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

/** The server entry keel registers: `KEEL_REPO="."` serves whichever repo .mcp.json sits in. */
export function keelServerEntry(command: string = DEFAULT_COMMAND): McpServerEntry {
  return { command, env: { KEEL_REPO: "." } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function initMcpConfig(options: InitOptions): InitResult | { error: string } {
  const dir = path.resolve(options.dir);
  const serverName = options.serverName ?? DEFAULT_SERVER_NAME;
  const entry = keelServerEntry(options.command);
  const configPath = path.join(dir, CONFIG_FILE);

  const existed = fs.existsSync(configPath);
  let config: McpConfig = {};
  if (existed) {
    let raw: string;
    try {
      raw = fs.readFileSync(configPath, "utf8");
    } catch (err) {
      return { error: `cannot read ${configPath}: ${(err as Error).message}` };
    }
    if (raw.trim() !== "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        return {
          error: `${configPath} is not valid JSON (${(err as Error).message}); leaving it untouched`,
        };
      }
      if (!isPlainObject(parsed)) {
        return { error: `${configPath} is not a JSON object; leaving it untouched` };
      }
      config = parsed as McpConfig;
    }
  }

  if ("mcpServers" in config && !isPlainObject(config.mcpServers)) {
    return { error: `${configPath} has a non-object "mcpServers"; leaving it untouched` };
  }
  const servers: Record<string, unknown> = isPlainObject(config.mcpServers) ? config.mcpServers : {};

  // Compare by serialized value so an identical re-run is a genuine no-op.
  if (JSON.stringify(servers[serverName]) === JSON.stringify(entry)) {
    return { path: configPath, action: "unchanged", serverName, entry };
  }

  servers[serverName] = entry;
  config.mcpServers = servers;
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  } catch (err) {
    return { error: `cannot write ${configPath}: ${(err as Error).message}` };
  }
  return { path: configPath, action: existed ? "updated" : "created", serverName, entry };
}

const INIT_HELP = `keel init — register the Keel MCP server in a project's .mcp.json

Usage: keel init [dir] [--name <name>] [--command <cmd>]

  dir              project directory to write .mcp.json into (default: KEEL_REPO or cwd)
  --name <name>    server key under mcpServers (default: keel)
  --command <cmd>  executable the client runs to launch keel (default: keel)

Merges into an existing .mcp.json without touching other servers; safe to re-run.`;

/** CLI wrapper: parse argv, run, print a summary. Returns the process exit code. */
export function runInit(argv: string[]): number {
  let dir: string | undefined;
  let serverName: string | undefined;
  let command: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") {
      console.log(INIT_HELP);
      return 0;
    }
    if (arg === "--name" || arg === "--command") {
      const value = argv[++i];
      if (value === undefined) {
        console.error(`[keel] init: ${arg} needs a value`);
        return 1;
      }
      if (arg === "--name") serverName = value;
      else command = value;
    } else if (arg.startsWith("-")) {
      console.error(`[keel] init: unknown option ${arg}`);
      return 1;
    } else if (dir === undefined) {
      dir = arg;
    } else {
      console.error(`[keel] init: unexpected argument ${arg}`);
      return 1;
    }
  }

  const result = initMcpConfig({
    dir: dir ?? process.env["KEEL_REPO"] ?? process.cwd(),
    ...(serverName !== undefined ? { serverName } : {}),
    ...(command !== undefined ? { command } : {}),
  });
  if ("error" in result) {
    console.error(`[keel] init failed: ${result.error}`);
    return 1;
  }

  if (result.action === "unchanged") {
    console.log(`[keel] "${result.serverName}" is already registered in ${result.path} (no changes)`);
    return 0;
  }
  console.log(
    `[keel] ${result.action} ${result.path} — registered "${result.serverName}" ` +
      `(command: ${result.entry.command}). Restart your MCP client to pick it up.`,
  );
  if (result.entry.command === DEFAULT_COMMAND) {
    console.log(`[keel] note: "${DEFAULT_COMMAND}" must be on the client's PATH; pass --command to override.`);
  }
  return 0;
}
