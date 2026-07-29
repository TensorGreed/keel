/**
 * ADR ingestion — the local, repo-only source for team memory. Architecture Decision Records under
 * docs/adr/ and docs/decisions/ are human-authored decisions; keel ingests them into the event log
 * as decision events with origin "adr", so `why` surfaces them alongside mined and human-pinned
 * records. They rank above mined records (an ADR is deliberate and human-authored) but below an
 * explicit `keel decision add` (a keel-specific override), see retrieval/why.ts.
 *
 * Pure ETL — NO model calls (CLAUDE.md principle 1). Parsing is deterministic (adr/parse.ts);
 * embedding for semantic search is a separate best-effort step in the CLI, exactly like mined and
 * human decisions. Idempotent by path + content hash: an unchanged ADR is skipped, an edited one
 * (new hash) replaces its prior event. Linked to graph nodes by scanning the body for repo-relative
 * paths that exist in the graph; an unlinked ADR still surfaces through question search.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { EventKind, KeelEvent } from "../events/store.js";
import type { SqliteEventStore } from "../events/sqlite-store.js";
import { parseAdr } from "./parse.js";

/** The conventional ADR locations, relative to the repo root. */
const ADR_DIRS = [["docs", "adr"], ["docs", "decisions"]];

export interface AdrIngestResult {
  scanned: number;
  /** ADRs newly ingested or re-ingested because their content changed */
  ingested: number;
  /** ADRs skipped because their content hash was unchanged */
  unchanged: number;
  /** ADRs linked to at least one graph file */
  linked: number;
}

function walkMarkdown(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!e.name.startsWith(".")) walkMarkdown(full, out);
    } else if (e.isFile() && /\.(?:md|markdown)$/i.test(e.name)) {
      out.push(full);
    }
  }
}

/** Every ADR markdown file under docs/adr and docs/decisions (repo-relative posix paths, sorted). */
export function findAdrFiles(repoRoot: string): string[] {
  const abs: string[] = [];
  for (const parts of ADR_DIRS) walkMarkdown(path.join(repoRoot, ...parts), abs);
  return abs.map((a) => path.relative(repoRoot, a).split(path.sep).join(path.posix.sep)).sort();
}

/** Repo-relative graph paths mentioned in an ADR body (markdown links, backticks, or bare paths). */
export function linkAdr(body: string, graphFiles: Set<string>): string[] {
  const found = new Set<string>();
  for (const m of body.matchAll(/[A-Za-z0-9_][A-Za-z0-9_./-]*\.[A-Za-z0-9]+/g)) {
    const token = m[0].replace(/^\.\//, "");
    if (graphFiles.has(token)) found.add(token);
  }
  return [...found].sort();
}

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function mtimeIso(abs: string): string {
  try {
    return fs.statSync(abs).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function normalizeDate(value: string, fallback: string): string {
  const t = Date.parse(value);
  return Number.isNaN(t) ? fallback : new Date(t).toISOString();
}

/**
 * Ingest ADRs into the decision index. Idempotent by content hash; an edited ADR replaces its prior
 * event (so its links and embedding are recomputed). Returns counts; the caller embeds best-effort.
 */
export async function ingestAdrs(
  store: SqliteEventStore,
  repoRoot: string,
  graphFiles: Set<string>,
): Promise<AdrIngestResult> {
  const files = findAdrFiles(repoRoot);

  // Existing ADR events → the content hash they were ingested from (for the idempotent skip).
  const existingHash = new Map<string, string>();
  for (const d of await store.byKind("decision", 100_000)) {
    if (d.payload["origin"] === "adr" && d.externalId && typeof d.payload["hash"] === "string") {
      existingHash.set(d.externalId, d.payload["hash"] as string);
    }
  }

  let ingested = 0;
  let unchanged = 0;
  let linked = 0;
  const toAppend: KeelEvent[] = [];
  const toDelete: { kind: EventKind; externalId: string }[] = [];

  for (const rel of files) {
    const abs = path.join(repoRoot, rel);
    let content: string;
    try {
      content = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const hash = sha1(content);
    const externalId = `adr:${rel}`;
    if (existingHash.get(externalId) === hash) {
      unchanged++;
      continue;
    }
    if (existingHash.has(externalId)) toDelete.push({ kind: "decision", externalId }); // edited — replace

    const parsed = parseAdr(content);
    const linkedFiles = linkAdr(parsed.body, graphFiles);
    if (linkedFiles.length > 0) linked++;

    toAppend.push({
      kind: "decision",
      externalId,
      occurredAt: parsed.date ? normalizeDate(parsed.date, mtimeIso(abs)) : mtimeIso(abs),
      title: parsed.title,
      payload: {
        origin: "adr",
        summary: parsed.title,
        // Prefer the decision section as the "why"; fall back to context, then nothing.
        rationale: parsed.decision ?? parsed.context ?? "",
        alternatives: [],
        confidence: "high",
        ...(parsed.status ? { status: parsed.status } : {}),
        adrPath: rel,
        hash,
      },
      ...(linkedFiles.length > 0 ? { files: linkedFiles } : {}),
    });
    ingested++;
  }

  // One transaction for the whole scan: stale records deleted and their replacements appended
  // together, so a crash can't drop an edited ADR's record without writing the new one.
  store.replaceEvents(toDelete, toAppend);
  return { scanned: files.length, ingested, unchanged, linked };
}
