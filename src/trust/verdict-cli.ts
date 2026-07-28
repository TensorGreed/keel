/**
 * `keel verdict` — run the trust-layer verdict from the shell (for CI checks and Claude Code
 * hooks; the same computation as the `verdict` MCP tool). Judges the working tree by default,
 * or a diff from --diff-file. Lazy-loaded from index.ts.
 *
 * Exit codes let simple gating work without parsing: 0 = pass or warn, 2 = block, 1 = error.
 * `--hook` reads the Claude Code Stop-hook payload on stdin and emits its control JSON on
 * stdout — block the agent from finishing on a failing verdict (see recipes/claude-code-hook.md).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { SqliteEventStore } from "../events/sqlite-store.js";
import { computeVerdict, type Verdict, type VerdictLevel } from "./verdict.js";

const VERDICT_HELP = `keel verdict — pass | warn | block a change against keel.policy.json

Usage: keel verdict [--diff-file PATH] [--json | --hook] [--max-tests N] [--max-seconds N]

  --diff-file PATH   judge this unified diff instead of the working tree
  --json             print the full verdict as JSON
  --hook             act as a Claude Code Stop hook: read the event on stdin, emit
                     block JSON on stdout when the verdict is block (honors stop_hook_active)
  --max-tests N      cap tests the sim runs (default 50 / KEEL_MAX_TESTS)
  --max-seconds N    sim wall-time cap in seconds (default 120 / KEEL_MAX_SECONDS)

Exit code: 0 = pass/warn, 2 = block, 1 = error. Reads the repo from KEEL_REPO or the cwd.`;

function warn(message: string): void {
  process.stderr.write(`[keel] ${message}\n`);
}

function exitCodeFor(verdict: VerdictLevel): number {
  return verdict === "block" ? 2 : 0;
}

/** Human summary of a verdict for a terminal. */
function printSummary(v: Verdict): void {
  const banner = v.verdict.toUpperCase();
  warn(`verdict: ${banner} (policy: ${v.policy.source})`);
  warn(
    `blast radius ${v.facts.blastRadius}, sim ${v.facts.sim.status}` +
      (v.facts.sim.passed !== undefined ? ` (${v.facts.sim.passed} passed, ${v.facts.sim.failed} failed)` : ""),
  );
  for (const r of v.reasons) {
    const mark = r.outcome === "block" ? "✗" : r.outcome === "warn" ? "!" : "✓";
    warn(`  ${mark} ${r.rule}: ${r.detail}`);
  }
}

/**
 * The Claude Code Stop-hook payload, read from stdin in --hook mode. We only care about
 * `stop_hook_active`: true means our previous block already re-triggered the agent, so we
 * must allow the stop this time or the session loops forever (verdict → block → retry → …).
 */
interface StopHookInput {
  stop_hook_active?: boolean;
}

function readHookInput(): StopHookInput | null {
  if (process.stdin.isTTY) return null; // invoked interactively, not from a hook
  try {
    const raw = fs.readFileSync(0, "utf8"); // fd 0: the JSON Claude Code pipes in
    if (!raw.trim()) return null;
    return JSON.parse(raw) as StopHookInput;
  } catch {
    return null; // a malformed/absent payload must not wedge the session — treat as a fresh stop
  }
}

/**
 * Claude Code Stop-hook output: block the agent from stopping on a failing verdict and feed
 * the reasons back so it fixes them; allow (empty) on pass/warn. Warnings still print to
 * stderr (surfaced in the hook transcript) without blocking.
 */
function stopHookOutput(v: Verdict): string {
  if (v.verdict !== "block") return ""; // allow the stop; nothing to inject
  const failing = v.reasons.filter((r) => r.outcome === "block").map((r) => `- ${r.rule}: ${r.detail}`).join("\n");
  const reason = `keel verdict: BLOCK. Address these before finishing:\n${failing}`;
  return JSON.stringify({ decision: "block", reason }) + "\n";
}

export async function runVerdict(argv: string[]): Promise<number> {
  let asJson = false;
  let asHook = false;
  let diffFile: string | undefined;
  let maxTests: number | undefined;
  let maxSeconds: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(VERDICT_HELP);
      return 0;
    }
    if (arg === "--json") asJson = true;
    else if (arg === "--hook") asHook = true;
    else if (arg === "--diff-file" || arg === "--max-tests" || arg === "--max-seconds") {
      const value = argv[++i];
      if (value === undefined) {
        warn(`verdict: ${arg} needs a value`);
        return 1;
      }
      if (arg === "--diff-file") {
        diffFile = value;
      } else {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) {
          warn(`verdict: ${arg} must be a positive integer, got "${value}"`);
          return 1;
        }
        if (arg === "--max-tests") maxTests = Math.floor(n);
        else maxSeconds = Math.floor(n);
      }
    } else {
      warn(`verdict: unexpected argument ${arg}`);
      return 1;
    }
  }

  // In hook mode, honor stop_hook_active before doing any work: if our earlier block already
  // bounced the agent back, allow the stop now — otherwise the session loops forever.
  if (asHook && readHookInput()?.stop_hook_active) return 0;

  const repoRoot = path.resolve(process.env["KEEL_REPO"] ?? process.cwd());
  let diff: string | undefined;
  if (diffFile !== undefined) {
    try {
      diff = fs.readFileSync(path.resolve(diffFile), "utf8");
    } catch (err) {
      warn(`verdict: cannot read ${diffFile}: ${(err as Error).message}`);
      return 1;
    }
  }

  const store = new SqliteEventStore(path.join(repoRoot, ".keel", "events.db"));
  try {
    const result = await computeVerdict(repoRoot, store, {
      ...(diff !== undefined ? { diff } : {}),
      ...(maxTests !== undefined ? { maxTests } : {}),
      ...(maxSeconds !== undefined ? { maxSeconds } : {}),
    });

    if ("error" in result) {
      if (asJson) console.log(JSON.stringify({ error: result.error }, null, 2));
      else warn(`verdict failed: ${result.error}`);
      // In hook mode an error must not silently block the agent — emit nothing (allow) but
      // report on stderr, so a keel misconfiguration doesn't wedge the session.
      if (asHook) warn(`verdict skipped: ${result.error}`);
      return 1;
    }

    if (asHook) {
      process.stdout.write(stopHookOutput(result));
      if (result.verdict !== "pass") printSummary(result); // surface warns/blocks on stderr
      return exitCodeFor(result.verdict);
    }
    if (asJson) console.log(JSON.stringify(result, null, 2));
    else printSummary(result);
    return exitCodeFor(result.verdict);
  } finally {
    store.close();
  }
}
