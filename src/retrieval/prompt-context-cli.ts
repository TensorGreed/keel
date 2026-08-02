/**
 * `keel prompt-context` — a Claude Code UserPromptSubmit hook. Reads the hook event on stdin,
 * matches the user's prompt against the decision index, and (only when there are hits) prints
 * `additionalContext` with the top decisions so the agent sees relevant memory it never asked for.
 *
 * Contract, because this runs on every prompt: never an error, never a block, never over budget.
 * Any failure — no store, no prompt, unreachable Ollama, a slow embed — resolves to empty output
 * and exit 0. A hook that slows or breaks every prompt gets uninstalled; this one stays invisible
 * until it has something worth saying. Lazy-loaded from index.ts.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { SqliteEventStore } from "../events/sqlite-store.js";
import { importDecisions } from "./decisions-file.js";
import { OllamaEmbeddingModel } from "./embed.js";
import { buildHookOutput, matchPromptDecisions, parseHookPrompt, renderAdditionalContext } from "./prompt-context.js";

const PROMPT_CONTEXT_HELP = `keel prompt-context — surface recorded decisions relevant to a prompt (Claude Code UserPromptSubmit hook)

Usage: keel prompt-context

Reads the hook event JSON on stdin, matches the user's prompt against keel's decision index
(keyword + local embeddings, hard ~1s budget), and prints UserPromptSubmit hook output whose
additionalContext lists the top decisions when there are hits. No hits → no output. Never errors
or blocks. Reads the repo from KEEL_REPO or the cwd. See recipes/claude-code-hook.md.`;

/** Ollama gets a short leash; the whole match is capped again below. Beyond this we go keyword-only. */
const EMBED_TIMEOUT_MS = 500;
/** Hard total budget for the match — a hook can't slow every prompt. */
const TOTAL_BUDGET_MS = 1000;

/** Read the hook payload from stdin (fd 0). Interactive/empty/malformed → null (stay silent). */
function readPrompt(): string | null {
  if (process.stdin.isTTY) return null; // run by hand, not from a hook
  let raw: string;
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    return null;
  }
  return parseHookPrompt(raw);
}

export async function runPromptContext(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(PROMPT_CONTEXT_HELP);
    return 0;
  }

  const prompt = readPrompt();
  if (prompt === null) return 0; // nothing to match against — silent

  const repoRoot = path.resolve(process.env["KEEL_REPO"] ?? process.cwd());
  const dbPath = path.join(repoRoot, ".keel", "events.db");
  // No event log means nothing has been ingested — stay silent, and don't create a DB as a side
  // effect of a hook that fires on every prompt.
  if (!fs.existsSync(dbPath)) return 0;

  let store: SqliteEventStore | undefined;
  try {
    store = new SqliteEventStore(dbPath);
    // Pick up decisions a teammate committed since this db was last touched. One stat() when the
    // file hasn't changed, which is every prompt but the first after a pull.
    await importDecisions(store, repoRoot);
    const embedModel = new OllamaEmbeddingModel(
      process.env["KEEL_EMBED_MODEL"],
      process.env["KEEL_OLLAMA_URL"],
      EMBED_TIMEOUT_MS,
    );
    const matches = await matchPromptDecisions(store, prompt, { embedModel, budgetMs: TOTAL_BUDGET_MS });
    const context = renderAdditionalContext(matches);
    if (context !== "") process.stdout.write(buildHookOutput(context));
  } catch {
    // Never surface an error to the hook — an empty result is always a valid "nothing to add".
  } finally {
    store?.close();
  }
  return 0;
}
