/**
 * `keel decision add|reject` — the human override channel for team memory. A person can pin
 * a decision (add), which always outranks mined records, or reject a mined one (kept in the
 * log for audit, excluded from `why`). Offline CLI; lazy-loaded from index.ts.
 */
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { SqliteEventStore } from "../events/sqlite-store.js";
import type { KeelEvent } from "../events/store.js";
import { embedDecisions, OllamaEmbeddingModel } from "../retrieval/embed.js";

const DECISION_HELP = `keel decision — record human decisions and overrides

Usage:
  keel decision add --summary "..." [--file F ...] [--rationale "..."]
                    [--alternatives "a; b"] [--confidence high|medium|low] [--author NAME]
  keel decision reject <id>     mark a mined decision suppressed (kept, excluded from why)

Human-added decisions always outrank mined ones in \`why\` output. A rejected decision stays
in the event log but is never returned, and survives re-running \`keel mine\`.`;

function warn(message: string): void {
  process.stderr.write(`[keel] ${message}\n`);
}

export interface AddOptions {
  summary: string;
  files: string[];
  rationale?: string;
  alternatives?: string[];
  confidence?: string;
  author?: string;
  /** injectable for tests; defaults to now */
  date?: string;
}

const HUMAN_SEQ_KEY = "decision.human.seq";

/** Write a human-origin decision event; returns its external id. */
export function addHumanDecision(store: SqliteEventStore, opts: AddOptions): string {
  const next = Number(store.getMeta(HUMAN_SEQ_KEY) ?? "0") + 1;
  store.setMeta(HUMAN_SEQ_KEY, String(next));
  const externalId = `decision:human:${next}`;
  const event: KeelEvent = {
    kind: "decision",
    externalId,
    occurredAt: opts.date ?? new Date().toISOString(),
    ...(opts.author ? { actor: opts.author } : {}),
    title: opts.summary,
    payload: {
      origin: "human",
      summary: opts.summary,
      rationale: opts.rationale ?? "",
      alternatives: opts.alternatives ?? [],
      confidence: opts.confidence ?? "high",
      author: opts.author ?? null,
    },
    ...(opts.files.length > 0 ? { files: opts.files } : {}),
  };
  store.appendMany([event]);
  return externalId;
}

function gitUserName(repoRoot: string): string | undefined {
  try {
    return execFileSync("git", ["config", "user.name"], { cwd: repoRoot }).toString().trim() || undefined;
  } catch {
    return undefined;
  }
}

async function runAdd(store: SqliteEventStore, repoRoot: string, argv: string[]): Promise<number> {
  const files: string[] = [];
  let summary: string | undefined;
  let rationale: string | undefined;
  let alternatives: string[] | undefined;
  let confidence: string | undefined;
  let author: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const need = (): string | undefined => argv[++i];
    switch (arg) {
      case "--file": {
        const v = need();
        if (v === undefined) return warn("decision add: --file needs a value"), 1;
        files.push(v);
        break;
      }
      case "--summary":
        summary = need();
        break;
      case "--rationale":
        rationale = need();
        break;
      case "--alternatives": {
        const v = need();
        alternatives = v ? v.split(/\s*[;,]\s*/).filter((s) => s !== "") : [];
        break;
      }
      case "--confidence":
        confidence = need();
        break;
      case "--author":
        author = need();
        break;
      default:
        return warn(`decision add: unexpected argument ${arg}`), 1;
    }
  }

  if (!summary || summary.trim() === "") {
    warn("decision add: --summary is required");
    return 1;
  }

  const id = addHumanDecision(store, {
    summary,
    files,
    ...(rationale !== undefined ? { rationale } : {}),
    ...(alternatives !== undefined ? { alternatives } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    author: author ?? gitUserName(repoRoot),
  });

  // Best-effort local embedding so the pinned decision is semantically searchable too.
  const embedResult = await embedDecisions(store, new OllamaEmbeddingModel(process.env["KEEL_EMBED_MODEL"], process.env["KEEL_OLLAMA_URL"]));
  if (embedResult.error) warn(`(not embedded: ${embedResult.error} — 'keel mine' will pick it up later)`);

  console.log(`[keel] added human decision ${id}${files.length ? ` linked to ${files.join(", ")}` : ""}`);
  return 0;
}

export async function runDecision(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === "--help" || sub === "-h") {
    console.log(DECISION_HELP);
    return sub === undefined ? 1 : 0;
  }

  const repoRoot = path.resolve(process.env["KEEL_REPO"] ?? process.cwd());
  const store = new SqliteEventStore(path.join(repoRoot, ".keel", "events.db"));
  try {
    if (sub === "add") return await runAdd(store, repoRoot, rest);
    if (sub === "reject") {
      const id = rest[0];
      if (id === undefined) {
        warn("decision reject: needs a decision id (see the id field in `why` output)");
        return 1;
      }
      store.suppressDecision(id);
      console.log(`[keel] rejected decision ${id} (kept in the log, excluded from why)`);
      return 0;
    }
    warn(`decision: unknown subcommand "${sub}" (use add or reject)`);
    return 1;
  } finally {
    store.close();
  }
}
