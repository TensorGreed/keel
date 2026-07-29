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
/** The published package name (`keel` is taken on npm), used for the npx fallback command. */
const PUBLISHED_NAME = "@tensorgreed/keel";

// --- CLAUDE.md agent guidance ----------------------------------------------

const CLAUDE_MD = "CLAUDE.md";
/** Idempotent markers around the managed block, so a re-run replaces exactly it and preserves
 *  everything a human wrote around it. */
const GUIDANCE_START = "<!-- keel:guidance:start -->";
const GUIDANCE_END = "<!-- keel:guidance:end -->";

/** The managed block appended to a target repo's CLAUDE.md — the distribution vehicle for the
 *  consultation habit: tool descriptions reach an agent at tool-choice time, this reaches it at
 *  session start. Kept short and imperative on purpose. */
function guidanceBlock(): string {
  return [
    GUIDANCE_START,
    "",
    "## Working with Keel",
    "",
    "Keel is available in this repo as an MCP server: a deterministic development-intelligence layer",
    "(system graph, an *executed* flight simulator, and team decision memory). Prefer it over guessing:",
    "",
    "- **Before starting work**, call `context` with your task — it returns the candidate files, their",
    "  blast radius, covering tests, and any recorded decisions that touch them.",
    "- **Before removing, reverting, or simplifying existing behavior**, call `why` on the file (or ask",
    "  a question). The code's current shape may be a recorded decision; endorsing its reversal without",
    "  checking is how teams relearn old lessons.",
    "- **Before finalizing a change**, call `preflight` — it applies your diff in a sandbox and runs the",
    "  covering tests, returning real pass/fail with traces, not a prediction.",
    "- **Before committing**, run `verdict` (or `keel verdict`) for a machine-checkable pass/warn/block.",
    "",
    GUIDANCE_END,
  ].join("\n");
}

export interface ClaudeMdResult {
  path: string;
  action: "created" | "updated" | "unchanged";
}

/**
 * Add (or refresh) Keel's agent-guidance section in the target repo's CLAUDE.md. Idempotent by the
 * marker comments: a first run appends the block (or creates the file); a re-run replaces just the
 * managed region, leaving everything a human wrote around it intact, and reports "unchanged" when
 * the file is byte-identical. Never overwrites a file it can't read.
 */
export function writeClaudeMdGuidance(dir: string): ClaudeMdResult | { error: string } {
  const filePath = path.join(path.resolve(dir), CLAUDE_MD);
  const block = guidanceBlock();

  const existed = fs.existsSync(filePath);
  let existing = "";
  if (existed) {
    try {
      existing = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      return { error: `cannot read ${filePath}: ${(err as Error).message}` };
    }
  }

  let next: string;
  const startIdx = existing.indexOf(GUIDANCE_START);
  const endIdx = existing.indexOf(GUIDANCE_END);
  if (!existed || existing.trim() === "") {
    next = block + "\n";
  } else if (startIdx !== -1 && endIdx > startIdx) {
    // Replace exactly the managed region; keep the user's text before and after it.
    next = existing.slice(0, startIdx) + block + existing.slice(endIdx + GUIDANCE_END.length);
  } else {
    next = existing.replace(/\n*$/, "") + "\n\n" + block + "\n"; // append after the user's content
  }

  if (existed && next === existing) {
    return { path: filePath, action: "unchanged" };
  }
  try {
    fs.writeFileSync(filePath, next);
  } catch (err) {
    return { error: `cannot write ${filePath}: ${(err as Error).message}` };
  }
  return { path: filePath, action: existed ? "updated" : "created" };
}

// --- Claude Code hook (.claude/settings.json) ------------------------------

const SETTINGS_DIR = ".claude";
const SETTINGS_FILE = "settings.json";
/** The UserPromptSubmit hook surfaces relevant decisions on each prompt (see prompt-context-cli). */
const HOOK_EVENT = "UserPromptSubmit";

/**
 * The command Claude Code runs on each prompt. `KEEL_REPO="$CLAUDE_PROJECT_DIR"` points keel at the
 * project (hooks run from an arbitrary cwd; Claude Code sets $CLAUDE_PROJECT_DIR). Mirrors the same
 * launch command written to .mcp.json, so whatever works for the server works for the hook.
 */
function promptContextHookCommand(command: string): string {
  return `KEEL_REPO="$CLAUDE_PROJECT_DIR" ${command} prompt-context`;
}

/** Our hook is a `command` entry that invokes the `prompt-context` subcommand — detected by that
 *  token so a re-run updates it in place rather than appending a duplicate, regardless of how the
 *  launch command is spelled (keel / npx / a local node path). */
function isPromptContextHook(cmd: unknown): boolean {
  return typeof cmd === "string" && /(^|\s)prompt-context(\s|$)/.test(cmd);
}

export interface SettingsResult {
  path: string;
  action: "created" | "updated" | "unchanged";
}

/**
 * Install (or refresh) the `prompt-context` UserPromptSubmit hook in the target repo's
 * .claude/settings.json. Non-destructive like .mcp.json: merges into an existing file, preserves
 * other hooks and top-level keys, is idempotent (a re-run with the same command reports
 * "unchanged"; a changed command updates in place without duplicating), and never overwrites a
 * file it can't parse. Failures come back as data.
 */
export function writeSettingsHook(dir: string, command: string): SettingsResult | { error: string } {
  const settingsDir = path.join(path.resolve(dir), SETTINGS_DIR);
  const filePath = path.join(settingsDir, SETTINGS_FILE);
  const desiredCommand = promptContextHookCommand(command);

  const existed = fs.existsSync(filePath);
  let settings: Record<string, unknown> = {};
  if (existed) {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      return { error: `cannot read ${filePath}: ${(err as Error).message}` };
    }
    if (raw.trim() !== "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        return { error: `${filePath} is not valid JSON (${(err as Error).message}); leaving it untouched` };
      }
      if (!isPlainObject(parsed)) {
        return { error: `${filePath} is not a JSON object; leaving it untouched` };
      }
      settings = parsed;
    }
  }

  if ("hooks" in settings && !isPlainObject(settings["hooks"])) {
    return { error: `${filePath} has a non-object "hooks"; leaving it untouched` };
  }
  const hooks: Record<string, unknown> = isPlainObject(settings["hooks"]) ? settings["hooks"] : {};

  if (HOOK_EVENT in hooks && !Array.isArray(hooks[HOOK_EVENT])) {
    return { error: `${filePath} has a non-array "hooks.${HOOK_EVENT}"; leaving it untouched` };
  }
  const groups: unknown[] = Array.isArray(hooks[HOOK_EVENT]) ? hooks[HOOK_EVENT] : [];

  // Update our entry in place if it's already there; otherwise append a fresh group.
  let found = false;
  let changed = false;
  for (const group of groups) {
    if (!isPlainObject(group) || !Array.isArray(group["hooks"])) continue;
    for (const h of group["hooks"]) {
      if (isPlainObject(h) && isPromptContextHook(h["command"])) {
        found = true;
        if (h["command"] !== desiredCommand) {
          h["command"] = desiredCommand;
          changed = true;
        }
      }
    }
  }
  if (!found) {
    groups.push({ hooks: [{ type: "command", command: desiredCommand }] });
    changed = true;
  }

  if (existed && !changed) {
    return { path: filePath, action: "unchanged" };
  }

  hooks[HOOK_EVENT] = groups;
  settings["hooks"] = hooks;
  try {
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(settings, null, 2) + "\n");
  } catch (err) {
    return { error: `cannot write ${filePath}: ${(err as Error).message}` };
  }
  return { path: filePath, action: existed ? "updated" : "created" };
}

/** Is `name` a runnable executable on the current PATH? Dependency-free; Windows-aware. */
function isExecutableOnPath(name: string): boolean {
  const dirs = (process.env["PATH"] ?? "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        fs.accessSync(path.join(dir, name + ext), fs.constants.X_OK);
        return true;
      } catch {
        // not here; keep looking
      }
    }
  }
  return false;
}

/**
 * The command to launch keel when the user doesn't pass --command. Prefer the bare `keel`
 * binary if it's on PATH; otherwise fall back to `npx -y <published-name>`, which fetches and
 * runs the package on demand — no global install required. Detected, never assumed.
 */
export function detectDefaultCommand(): { command: string; onPath: boolean } {
  return isExecutableOnPath(DEFAULT_COMMAND)
    ? { command: DEFAULT_COMMAND, onPath: true }
    : { command: `npx -y ${PUBLISHED_NAME}`, onPath: false };
}

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

Usage: keel init [dir] [--name <name>] [--command <cmd>] [--no-claude-md] [--no-hooks]

  dir              project directory to write .mcp.json into (default: KEEL_REPO or cwd)
  --name <name>    server key under mcpServers (default: keel)
  --command <cmd>  command the client runs to launch keel
                   (default: "keel" if on PATH, else "npx -y ${PUBLISHED_NAME}")
  --no-claude-md   skip adding Keel usage guidance to the repo's CLAUDE.md (added by default)
  --no-hooks       skip installing the prompt-context UserPromptSubmit hook in
                   .claude/settings.json (installed by default)

Merges into an existing .mcp.json without touching other servers, adds a short "Working with Keel"
section to CLAUDE.md (between idempotent markers), and installs a UserPromptSubmit hook that
surfaces relevant decisions on each prompt. All three are non-destructive and safe to re-run.`;

/** CLI wrapper: parse argv, run, print a summary. Returns the process exit code. */
export function runInit(argv: string[]): number {
  let dir: string | undefined;
  let serverName: string | undefined;
  let command: string | undefined;
  let claudeMd = true;
  let hooks = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") {
      console.log(INIT_HELP);
      return 0;
    }
    if (arg === "--claude-md" || arg === "--no-claude-md") {
      claudeMd = arg === "--claude-md";
      continue;
    }
    if (arg === "--hooks" || arg === "--no-hooks") {
      hooks = arg === "--hooks";
      continue;
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

  // Resolve the command up front so we can tell the user exactly which one we wrote and why.
  let effectiveCommand = command;
  let autoNote: string | undefined;
  if (effectiveCommand === undefined) {
    const detected = detectDefaultCommand();
    effectiveCommand = detected.command;
    autoNote = detected.onPath
      ? `note: wrote "${detected.command}" — it must stay on the client's PATH; pass --command to override.`
      : `note: "${DEFAULT_COMMAND}" isn't on PATH, so I wrote "${detected.command}" (npx fetches the published package on demand). ` +
        `Pass --command to override — e.g. --command "node ./dist/index.js" for a local build.`;
  }

  const targetDir = dir ?? process.env["KEEL_REPO"] ?? process.cwd();
  const result = initMcpConfig({
    dir: targetDir,
    ...(serverName !== undefined ? { serverName } : {}),
    command: effectiveCommand,
  });
  if ("error" in result) {
    console.error(`[keel] init failed: ${result.error}`);
    return 1;
  }

  if (result.action === "unchanged") {
    console.log(`[keel] "${result.serverName}" is already registered in ${result.path} (no changes)`);
  } else {
    console.log(
      `[keel] ${result.action} ${result.path} — registered "${result.serverName}" ` +
        `(command: ${result.entry.command}). Restart your MCP client to pick it up.`,
    );
    if (autoNote) console.log(`[keel] ${autoNote}`);
  }

  // Agent guidance in the target repo's CLAUDE.md — reaches an agent at session start, where a tool
  // description can't. Non-fatal: the .mcp.json registration is the primary job.
  if (claudeMd) {
    const md = writeClaudeMdGuidance(targetDir);
    if ("error" in md) {
      console.error(`[keel] note: could not update CLAUDE.md (${md.error}); .mcp.json is registered`);
    } else if (md.action === "unchanged") {
      console.log(`[keel] Keel guidance already present in ${md.path} (no changes)`);
    } else {
      console.log(`[keel] ${md.action} ${md.path} — added a "Working with Keel" section for agents.`);
    }
  }

  // The prompt-context UserPromptSubmit hook in .claude/settings.json — surfaces relevant decisions
  // on each prompt (the passive companion to the verdict Stop hook; that stronger gate stays opt-in
  // via recipes/claude-code-hook.md). Non-fatal, like the CLAUDE.md write.
  if (hooks) {
    const settings = writeSettingsHook(targetDir, effectiveCommand);
    if ("error" in settings) {
      console.error(`[keel] note: could not install the prompt-context hook (${settings.error}); .mcp.json is registered`);
    } else if (settings.action === "unchanged") {
      console.log(`[keel] prompt-context hook already present in ${settings.path} (no changes)`);
    } else {
      console.log(
        `[keel] ${settings.action} ${settings.path} — installed a UserPromptSubmit hook ` +
          `(surfaces relevant decisions on each prompt; silent when it has none). Pass --no-hooks to skip.`,
      );
    }
  }
  return 0;
}
