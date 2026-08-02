/**
 * Decisions as code: `.keel-decisions.jsonl`, a committed export of the decision index.
 *
 * ## Why this exists
 *
 * Team memory was, until now, trapped in `.keel/events.db` — gitignored, per-machine, and rebuilt
 * only by re-running `keel mine` (which costs a model pass, even a local one). That makes the most
 * valuable thing keel produces the least shareable: the person who mined the repo has the memory,
 * and nobody else does. A fresh clone knew nothing, and every new machine and every CI runner and
 * every agent started from zero.
 *
 * One person mines. They commit this file. Every clone thereafter — every teammate, every agent —
 * has the memory immediately, with no mining, no model, and no network. It is reviewable in a pull
 * request like anything else in the repo, which also means a bad mined record can be *fixed by
 * editing a line* rather than by re-running a pipeline.
 *
 * ## Why JSONL, sorted, one line per record
 *
 * The file's job is to be diffed by humans. One record per line means adding a decision is a
 * one-line diff instead of a re-indented block; sorting by id means the diff shows what changed
 * rather than where things moved. Key order is fixed and the encoding is compact, so the same
 * database always produces byte-identical output — otherwise every export would churn the file and
 * teams would learn to stop reading the diff.
 *
 * ## What is NOT in it
 *
 * Embeddings. They are large, opaque, machine- and model-specific, and would turn a reviewable text
 * file into a binary blob nobody reads. Each machine recomputes them lazily and locally; until it
 * does, retrieval falls back to keyword matching, which is the documented degradation everywhere
 * else in keel (principle 1). Vectors don't belong in git.
 *
 * ## Conflict rule
 *
 * A local human record wins over the file; the file wins over nothing; a suppression in the file
 * suppresses everywhere. In practice that means import only ever *fills gaps* — it never overwrites
 * or deletes a local record — while suppression always applies, because a rejected decision that
 * came back on a teammate's machine would be the one failure mode nobody would forgive.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { KeelEvent } from "../events/store.js";
import type { SqliteEventStore } from "../events/sqlite-store.js";

export const DECISIONS_FILE = ".keel-decisions.jsonl";
/** Meta key holding the stamp of the file as last imported, so a no-op sync costs one stat(). */
const STAMP_KEY = "decisions.file.stamp";
/** Nobody's decision index is bigger than this; the bound keeps a corrupt file from eating memory. */
const MAX_RECORDS = 100_000;

/** One line of the file. Field order here IS the serialized order — keep it stable. */
export interface DecisionRecord {
  external_id: string;
  origin: string;
  summary: string;
  rationale: string;
  alternatives: string[];
  confidence: string;
  files: string[];
  source: { pr: number | null; url: string | null; adr: string | null; author: string | null; date: string };
  suppressed: boolean;
}

export interface ExportResult {
  path: string;
  records: number;
  suppressed: number;
  /** true when the file's bytes changed — callers use it to decide whether to mention it */
  changed: boolean;
}

export interface ImportResult {
  /** records inserted because the local index lacked them */
  imported: number;
  /** ids suppressed because the file says they are */
  suppressed: number;
  /** records already present locally and therefore left alone */
  skipped: number;
  /** lines that could not be read, with why — reported, never fatal */
  warnings: string[];
  /** false when the file isn't there at all (the normal case for a repo that hasn't adopted it) */
  present: boolean;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** A decision event as its file record. Pure; the inverse of `toEvent`. */
export function toRecord(decision: KeelEvent, suppressed: boolean): DecisionRecord {
  const p = decision.payload;
  return {
    external_id: decision.externalId ?? "",
    origin: str(p["origin"], "mined"),
    summary: str(p["summary"], decision.title ?? ""),
    rationale: str(p["rationale"]),
    // Order carries meaning in a list of alternatives ("we considered A, then B") — never sorted.
    alternatives: Array.isArray(p["alternatives"]) ? p["alternatives"].filter((a): a is string => typeof a === "string") : [],
    confidence: str(p["confidence"], "low"),
    // Files ARE a set, so sorting them is what makes two exports of one database identical.
    files: [...(decision.files ?? [])].sort(),
    source: {
      pr: typeof p["prNumber"] === "number" ? p["prNumber"] : null,
      url: typeof p["prUrl"] === "string" ? p["prUrl"] : null,
      adr: typeof p["adrPath"] === "string" ? p["adrPath"] : null,
      author: decision.actor ?? (typeof p["author"] === "string" ? p["author"] : null),
      date: decision.occurredAt,
    },
    suppressed,
  };
}

/** A file record as a decision event. Pure; the inverse of `toRecord`. */
export function toEvent(record: DecisionRecord): KeelEvent {
  return {
    kind: "decision",
    externalId: record.external_id,
    occurredAt: record.source.date,
    ...(record.source.author ? { actor: record.source.author } : {}),
    title: record.summary,
    payload: {
      origin: record.origin,
      summary: record.summary,
      rationale: record.rationale,
      alternatives: record.alternatives,
      confidence: record.confidence,
      author: record.source.author,
      ...(record.source.pr !== null ? { prNumber: record.source.pr } : {}),
      ...(record.source.url !== null ? { prUrl: record.source.url } : {}),
      ...(record.source.adr !== null ? { adrPath: record.source.adr } : {}),
    },
    ...(record.files.length > 0 ? { files: record.files } : {}),
  };
}

/**
 * Serialize records to the file's exact bytes. Sorted by id and compactly encoded, so the same
 * database always produces the same file — the property that keeps the diff readable.
 */
export function serializeDecisions(records: DecisionRecord[]): string {
  const sorted = [...records].sort((a, b) => a.external_id.localeCompare(b.external_id));
  return sorted.map((r) => JSON.stringify(r)).join("\n") + (sorted.length > 0 ? "\n" : "");
}

/** Parse the file, skipping any line it can't read and saying so. Never throws on content. */
export function parseDecisions(text: string): { records: DecisionRecord[]; warnings: string[] } {
  const records: DecisionRecord[] = [];
  const warnings: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    if (records.length >= MAX_RECORDS) {
      warnings.push(`${DECISIONS_FILE}: stopped at ${MAX_RECORDS} records; the rest of the file was ignored`);
      break;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      warnings.push(`${DECISIONS_FILE}:${i + 1}: not valid JSON (${(err as Error).message}) — line skipped`);
      continue;
    }
    const record = coerce(parsed);
    if ("error" in record) {
      warnings.push(`${DECISIONS_FILE}:${i + 1}: ${record.error} — line skipped`);
      continue;
    }
    records.push(record.record);
  }
  return { records, warnings };
}

/** Validate one parsed line into a record. A line missing its identity is unusable; the rest is
 *  filled with defaults, because a partially-written record still carries its decision. */
function coerce(value: unknown): { record: DecisionRecord } | { error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { error: "not a JSON object" };
  const v = value as Record<string, unknown>;
  const id = v["external_id"];
  if (typeof id !== "string" || id === "") return { error: "missing external_id" };
  const source = (typeof v["source"] === "object" && v["source"] !== null ? v["source"] : {}) as Record<string, unknown>;
  const date = str(source["date"]);
  if (date === "") return { error: "missing source.date" };
  return {
    record: {
      external_id: id,
      origin: str(v["origin"], "mined"),
      summary: str(v["summary"]),
      rationale: str(v["rationale"]),
      alternatives: Array.isArray(v["alternatives"]) ? v["alternatives"].filter((a): a is string => typeof a === "string") : [],
      confidence: str(v["confidence"], "low"),
      files: Array.isArray(v["files"]) ? v["files"].filter((f): f is string => typeof f === "string") : [],
      source: {
        pr: typeof source["pr"] === "number" ? source["pr"] : null,
        url: typeof source["url"] === "string" ? source["url"] : null,
        adr: typeof source["adr"] === "string" ? source["adr"] : null,
        author: typeof source["author"] === "string" ? source["author"] : null,
        date,
      },
      suppressed: v["suppressed"] === true,
    },
  };
}

/**
 * Write every decision in the store to `.keel-decisions.jsonl`. Skips the write entirely when the
 * bytes are unchanged, so an export that changes nothing doesn't touch the file's mtime and make
 * git report a modification that isn't one.
 */
export async function exportDecisions(store: SqliteEventStore, repoRoot: string): Promise<ExportResult> {
  const file = path.join(repoRoot, DECISIONS_FILE);
  const suppressed = store.suppressedDecisions();
  const decisions = await store.byKind("decision", MAX_RECORDS);
  const records = decisions
    .filter((d) => d.externalId !== undefined)
    .map((d) => toRecord(d, suppressed.has(d.externalId!)));

  const text = serializeDecisions(records);
  let previous: string | null = null;
  try {
    previous = fs.readFileSync(file, "utf8");
  } catch {
    previous = null;
  }
  const changed = previous !== text;
  if (changed) fs.writeFileSync(file, text);
  // Stamp what we just wrote, so the importer doesn't immediately re-read our own export.
  stampFile(store, file);
  return { path: file, records: records.length, suppressed: records.filter((r) => r.suppressed).length, changed };
}

/** size:mtime of the file as last seen — cheap enough to check on every startup. */
function stampOf(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    return `${stat.size}:${Math.round(stat.mtimeMs)}`;
  } catch {
    return null;
  }
}

function stampFile(store: SqliteEventStore, file: string): void {
  const stamp = stampOf(file);
  if (stamp) store.setMeta(STAMP_KEY, stamp);
}

/**
 * Load `.keel-decisions.jsonl` into the local index, filling gaps only.
 *
 * Idempotent and cheap: a file whose stamp matches the last import is skipped after one stat(), so
 * this can run on every startup. The stamp lives in the database, so a wiped or fresh `.keel/` —
 * exactly the clone case this feature is for — always re-imports.
 */
export async function importDecisions(
  store: SqliteEventStore,
  repoRoot: string,
  options: { force?: boolean } = {},
): Promise<ImportResult> {
  const file = path.join(repoRoot, DECISIONS_FILE);
  const empty: ImportResult = { imported: 0, suppressed: 0, skipped: 0, warnings: [], present: false };

  const stamp = stampOf(file);
  if (stamp === null) return empty;
  if (!options.force && store.getMeta(STAMP_KEY) === stamp) return { ...empty, present: true };

  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    return { ...empty, present: true, warnings: [`cannot read ${DECISIONS_FILE}: ${(err as Error).message}`] };
  }

  const { records, warnings } = parseDecisions(text);
  const existing = new Set(
    (await store.byKind("decision", MAX_RECORDS)).map((d) => d.externalId).filter((id): id is string => id !== undefined),
  );

  // Fill gaps only. A local record — human-added above all — is never overwritten or removed by the
  // file, which is what makes it safe to run this on every startup.
  const toAppend: KeelEvent[] = [];
  let skipped = 0;
  for (const record of records) {
    if (existing.has(record.external_id)) skipped++;
    else toAppend.push(toEvent(record));
  }
  if (toAppend.length > 0) store.appendMany(toAppend);

  // Suppression is absolute and applies to local records too: a decision the team rejected must not
  // come back to life on a teammate's machine.
  let suppressedCount = 0;
  const alreadySuppressed = store.suppressedDecisions();
  for (const record of records) {
    if (!record.suppressed || alreadySuppressed.has(record.external_id)) continue;
    store.suppressDecision(record.external_id);
    suppressedCount++;
  }

  stampFile(store, file);
  return { imported: toAppend.length, suppressed: suppressedCount, skipped, warnings, present: true };
}
