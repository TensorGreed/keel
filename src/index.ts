#!/usr/bin/env node
/**
 * Keel CLI entry + command dispatch.
 *
 *   keel [serve]   start the MCP server over stdio (default) — see serve.ts
 *   keel init      register keel in a project's .mcp.json      — see init.ts
 *   keel ingest    ADRs (local) + GitHub PRs into the event log — see github/cli.ts
 *   keel mine      extract decision records from PR threads    — see mining/cli.ts
 *   keel decision  add/reject human decision overrides         — see mining/decision-cli.ts
 *   keel ci        ingest JUnit CI reports into the event log   — see ci/cli.ts
 *   keel verdict   pass/warn/block a change vs keel.policy.json — see trust/verdict-cli.ts
 *   keel report    repo-wide policy reports (--arch)          — see trust/report-cli.ts
 *   keel workspace cross-repo graph over keel.workspace.json  — see workspace/cli.ts
 *
 * Subcommand modules are imported lazily so `keel init` doesn't spin up the MCP SDK,
 * SQLite, or commit ingestion.
 */
import { readFileSync } from "node:fs";

const HELP = `keel — development intelligence layer, delivered as an MCP server

Usage:
  keel [serve]   start the MCP server over stdio (default)
  keel init      register keel in this project's .mcp.json
  keel ingest    ingest ADRs (docs/adr, docs/decisions) locally, plus GitHub PRs
  keel mine      extract decision records from ingested PR threads (offline model)
  keel decision  record a human decision (add) or reject a mined one
  keel ci        ingest JUnit test reports from a CI run (for flaky-test detection)
  keel verdict   pass/warn/block a change against keel.policy.json (for CI / hooks)
  keel report    repo-wide policy reports, e.g. --arch for import-rule violations
  keel workspace one dependency graph across repos (keel.workspace.json)
  keel --help    show this help
  keel --version print the version

serve reads the target repo from KEEL_REPO (defaults to the current directory).`;

function readVersion(): string {
  try {
    // dist/index.js -> ../package.json; same layout in the published package.
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case "init": {
    const { runInit } = await import("./init.js");
    process.exit(runInit(rest));
    break;
  }
  case "ingest": {
    const { runIngest } = await import("./github/cli.js");
    process.exit(await runIngest(rest));
    break;
  }
  case "mine": {
    const { runMine } = await import("./mining/cli.js");
    process.exit(await runMine(rest));
    break;
  }
  case "decision": {
    const { runDecision } = await import("./mining/decision-cli.js");
    process.exit(await runDecision(rest));
    break;
  }
  case "ci": {
    const { runCi } = await import("./ci/cli.js");
    process.exit(await runCi(rest));
    break;
  }
  case "verdict": {
    const { runVerdict } = await import("./trust/verdict-cli.js");
    process.exit(await runVerdict(rest));
    break;
  }
  case "report": {
    const { runReport } = await import("./trust/report-cli.js");
    process.exit(await runReport(rest));
    break;
  }
  case "workspace": {
    const { runWorkspace } = await import("./workspace/cli.js");
    process.exit(await runWorkspace(rest));
    break;
  }
  case "-h":
  case "--help":
  case "help":
    console.log(HELP);
    break;
  case "-v":
  case "--version":
    console.log(readVersion());
    break;
  case undefined:
  case "serve": {
    const { serve } = await import("./serve.js");
    await serve();
    break;
  }
  default:
    console.error(`[keel] unknown command: ${command}\n`);
    console.error(HELP);
    process.exit(1);
}
