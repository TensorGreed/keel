/**
 * `keel mine` — extract decision records from ingested PR threads. Lazy-loaded from
 * index.ts. Offline pipeline: uses a local (Ollama) or batch Haiku-class model — the only
 * place keel makes model calls (see CLAUDE.md).
 */
import * as path from "node:path";
import { SqliteEventStore } from "../events/sqlite-store.js";
import { mineDecisions } from "./mine.js";
import { AnthropicModel, OllamaModel, type DecisionModel } from "./model.js";
import { embedDecisions, OllamaEmbeddingModel } from "../retrieval/embed.js";

const MINE_HELP = `keel mine — extract decision records from ingested PR threads

Usage: keel mine [--model ollama|anthropic] [--limit N] [--no-embed]

  --model ollama      use a local Ollama model (default)
  --model anthropic   use a Haiku-class model via the Anthropic API (needs ANTHROPIC_API_KEY)
  --limit N           cap PRs mined this run (newest first, default 200)
  --no-embed          skip computing embeddings for semantic retrieval

The extraction model name is KEEL_MINER_MODEL (default llama3.2 for ollama, claude-haiku-4-5
for anthropic); embeddings use a local model, KEEL_EMBED_MODEL (default nomic-embed-text).
Ollama's base URL is KEEL_OLLAMA_URL (default http://localhost:11434). Run 'keel ingest'
first to populate PR threads. Safe to re-run — already-mined/embedded records are skipped.`;

function warn(message: string): void {
  process.stderr.write(`[keel] ${message}\n`);
}

/** Build the model from flags/env, or return an error message. */
function selectModel(provider: string): DecisionModel | { error: string } {
  const modelName = process.env["KEEL_MINER_MODEL"];
  if (provider === "ollama") {
    const url = process.env["KEEL_OLLAMA_URL"];
    return new OllamaModel(modelName, url);
  }
  if (provider === "anthropic") {
    const key = process.env["ANTHROPIC_API_KEY"];
    if (!key) return { error: "ANTHROPIC_API_KEY is not set (required for --model anthropic)" };
    return new AnthropicModel(key, modelName);
  }
  return { error: `unknown --model "${provider}" (use ollama or anthropic)` };
}

export async function runMine(argv: string[]): Promise<number> {
  let provider = "ollama";
  let limit: number | undefined;
  let embed = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(MINE_HELP);
      return 0;
    }
    if (arg === "--no-embed") {
      embed = false;
      continue;
    }
    if (arg === "--model" || arg === "--limit") {
      const value = argv[++i];
      if (value === undefined) {
        warn(`mine: ${arg} needs a value`);
        return 1;
      }
      if (arg === "--model") {
        provider = value;
      } else {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) {
          warn(`mine: --limit must be a positive integer, got "${value}"`);
          return 1;
        }
        limit = Math.floor(n);
      }
    } else {
      warn(`mine: unexpected argument ${arg}`);
      return 1;
    }
  }

  const model = selectModel(provider);
  if ("error" in model) {
    warn(`mine failed: ${model.error}`);
    return 1;
  }

  const repoRoot = path.resolve(process.env["KEEL_REPO"] ?? process.cwd());
  const store = new SqliteEventStore(path.join(repoRoot, ".keel", "events.db"));
  try {
    warn(`mining decisions with ${model.name}…`);
    const result = await mineDecisions(store, model, limit !== undefined ? { limit } : {});
    console.log(
      `[keel] mined ${result.mined} decision(s) from ${result.total} PR(s) ` +
        `(${result.skipped} already mined, ${result.noDecision} no decision, ${result.errors} error(s)) via ${result.model}`,
    );

    // Embed the decisions for semantic retrieval (best-effort, local model). Missing this
    // only disables semantic search — retrieval-by-file still works. Idempotent, so a later
    // re-run picks up anything the embedding model couldn't reach this time.
    if (embed) {
      const embedModel = new OllamaEmbeddingModel(process.env["KEEL_EMBED_MODEL"], process.env["KEEL_OLLAMA_URL"]);
      const embedResult = await embedDecisions(store, embedModel);
      if (embedResult.error) {
        warn(`embeddings skipped: ${embedResult.error} (run 'keel mine' again to retry — decisions are saved)`);
      } else {
        console.log(
          `[keel] embedded ${embedResult.embedded} decision(s) (${embedResult.skipped} already embedded) via ${embedResult.model}`,
        );
      }
    }
    return result.errors > 0 && result.mined === 0 ? 1 : 0;
  } finally {
    store.close();
  }
}
