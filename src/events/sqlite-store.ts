/**
 * Event log v1: SQLite persistence for the EventStore interface, via node:sqlite's
 * DatabaseSync. No native or npm dependency — that's the whole reason we chose
 * node:sqlite over better-sqlite3.
 *
 * The store is the substrate the rest of Keel writes into: commits ingested on startup
 * (see ingest.ts), then Phase 1 simulation results and Phase 2 PR/review events. It is
 * plain ETL — no LLM calls in this layer (see CLAUDE.md).
 */
import "./sqlite-warning.js"; // must precede loading node:sqlite — see that module
import * as fs from "node:fs";
import * as path from "node:path";
import type * as Sqlite from "node:sqlite";
import type { EventKind, EventStore, KeelEvent } from "./store.js";
import { sqliteBusyTimeoutMs } from "../util/timeouts.js";

// node:sqlite emits its ExperimentalWarning while the module is *loaded*, which for a
// static import happens during ESM linking — before sqlite-warning.js's patch runs. A
// deferred import loads it during evaluation instead, after the patch is installed.
const { DatabaseSync } = await import("node:sqlite");

/**
 * Bump when the on-disk schema changes in a way that needs a migration. Stored in the
 * meta table so a newer binary can migrate an older DB (and an older binary can refuse
 * a newer one) rather than corrupting it.
 */
export const SCHEMA_VERSION = 1;

const SCHEMA_SQL = fs.readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

/** node:sqlite surfaces SQLITE_BUSY as an Error with code ERR_SQLITE_ERROR and a "database is
 *  locked"/"busy" message — the transient contention we retry through at open. */
function isLockedError(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === "ERR_SQLITE_ERROR" && /database is locked|database table is locked|is busy/i.test(e.message ?? "");
}

/** Synchronous sleep (constructors can't await). Only ever hit on the rare open-time lock retry. */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

interface EventRow {
  id: number | bigint;
  kind: string;
  external_id: string | null;
  occurred_at: string;
  actor: string | null;
  title: string | null;
  payload: string;
}

export class SqliteEventStore implements EventStore {
  private readonly db: Sqlite.DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    this.db = new DatabaseSync(dbPath);
    this.initialize();
  }

  /**
   * Configure and migrate the db, retrying the whole block on a transient "database is locked".
   * The switch to WAL (`PRAGMA journal_mode = WAL`) needs a brief EXCLUSIVE lock that busy_timeout
   * doesn't always cover, so two processes creating a brand-new db at the same instant can each
   * see a lock error here. Every statement is idempotent (PRAGMAs, CREATE IF NOT EXISTS), so we
   * just back off and retry until busy_timeout's worth of wall-clock has passed — then the loser
   * finds the db already in WAL and sails through. The steady state (an existing WAL db) never
   * retries.
   */
  private initialize(): void {
    const deadline = Date.now() + sqliteBusyTimeoutMs();
    for (let attempt = 0; ; attempt++) {
      try {
        // busy_timeout FIRST, so the ordinary lock waits below are honored. The server, the
        // prompt-context hook, and `keel mine` can all open this db at once.
        this.db.exec(`PRAGMA busy_timeout = ${sqliteBusyTimeoutMs()}`);
        // WAL: concurrent readers never block the writer, and it's crash-safe — a hard kill
        // mid-write leaves only committed frames behind; SQLite discards the torn tail on next
        // open, so the db is never corrupt, only ever missing the uncommitted transaction.
        this.db.exec("PRAGMA journal_mode = WAL");
        // NORMAL is the canonical WAL pairing: a committed transaction survives a process crash
        // (our kill-safety contract), trading only a possible loss of the very last commit on a
        // full OS/power loss — fine for a re-runnable cache/log, and faster under contention.
        this.db.exec("PRAGMA synchronous = NORMAL");
        this.db.exec("PRAGMA foreign_keys = ON");
        this.db.exec(SCHEMA_SQL);
        this.applySchemaVersion();
        return;
      } catch (err) {
        if (!isLockedError(err) || Date.now() >= deadline) throw err;
        sleepMs(Math.min(25 * (attempt + 1), 200)); // brief backoff, then retry the idempotent setup
      }
    }
  }

  private applySchemaVersion(): void {
    const current = this.getMeta("schema_version");
    if (current === undefined) {
      this.setMeta("schema_version", String(SCHEMA_VERSION));
      return;
    }
    const version = Number(current);
    if (version > SCHEMA_VERSION) {
      process.stderr.write(
        `[keel] warning: events.db schema v${version} is newer than this build (v${SCHEMA_VERSION}); ` +
          `some data may be ignored\n`,
      );
    }
    // No forward migrations yet; when a v2 lands, step from `version` to SCHEMA_VERSION here.
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  async append(event: KeelEvent): Promise<void> {
    this.transaction(() => this.insertOne(event));
  }

  /**
   * Insert many events in a single transaction. Returns how many were *newly* inserted
   * (duplicates, matched by UNIQUE(kind, external_id), are ignored) so callers can report
   * real progress. Batch inserts belong in one transaction — one fsync, not one per row.
   */
  appendMany(events: KeelEvent[]): number {
    let inserted = 0;
    this.transaction(() => {
      for (const event of events) if (this.insertOne(event)) inserted++;
    });
    return inserted;
  }

  private insertOne(event: KeelEvent): boolean {
    const result = this.db
      .prepare(
        "INSERT OR IGNORE INTO events (kind, external_id, occurred_at, actor, title, payload) " +
          "VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        event.kind,
        event.externalId ?? null,
        event.occurredAt,
        event.actor ?? null,
        event.title ?? null,
        JSON.stringify(event.payload ?? {}),
      );
    // changes === 0 means the row already existed (idempotent re-ingest); its files are
    // already present, so don't touch event_files.
    if (result.changes === 0) return false;

    const insertFile = this.db.prepare("INSERT OR IGNORE INTO event_files (event_id, path) VALUES (?, ?)");
    for (const file of event.files ?? []) insertFile.run(result.lastInsertRowid, file);
    return true;
  }

  async byFile(filePath: string, limit = 50): Promise<KeelEvent[]> {
    const rows = this.db
      .prepare(
        "SELECT e.* FROM events e JOIN event_files f ON f.event_id = e.id " +
          "WHERE f.path = ? ORDER BY e.occurred_at DESC, e.id DESC LIMIT ?",
      )
      .all(filePath, limit) as unknown as EventRow[];
    return rows.map((row) => this.hydrate(row));
  }

  async byKind(kind: EventKind, limit = 50): Promise<KeelEvent[]> {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE kind = ? ORDER BY occurred_at DESC, id DESC LIMIT ?")
      .all(kind, limit) as unknown as EventRow[];
    return rows.map((row) => this.hydrate(row));
  }

  /**
   * Store an embedding for an event, replacing any prior one. Keyed by the event's row id
   * (looked up from kind + external_id), so it's tied to the event and cleaned up with it.
   * No-op if the event doesn't exist. The vector is stored as raw float32 bytes.
   */
  setEmbedding(kind: EventKind, externalId: string, vector: Float32Array): void {
    this.setEmbeddingRow(kind, externalId, vector);
  }

  /**
   * Store many embeddings in one transaction — one fsync for the batch, and crash-atomic (a kill
   * mid-batch leaves either all-committed or none, never a torn half). Used by the offline
   * embedding pass, which computes vectors in batches.
   */
  setEmbeddings(items: { kind: EventKind; externalId: string; vector: Float32Array }[]): void {
    this.transaction(() => {
      for (const it of items) this.setEmbeddingRow(it.kind, it.externalId, it.vector);
    });
  }

  private setEmbeddingRow(kind: EventKind, externalId: string, vector: Float32Array): void {
    const row = this.db
      .prepare("SELECT id FROM events WHERE kind = ? AND external_id = ?")
      .get(kind, externalId) as { id: number | bigint } | undefined;
    if (!row) return;
    const bytes = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    this.db
      .prepare("INSERT OR REPLACE INTO embeddings (event_id, dim, vector) VALUES (?, ?, ?)")
      .run(row.id, vector.length, bytes);
  }

  /** external_id -> embedding vector, for every embedded event of a kind (for retrieval). */
  embeddingsByKind(kind: EventKind): Map<string, Float32Array> {
    const rows = this.db
      .prepare(
        "SELECT e.external_id AS externalId, m.vector AS vector FROM embeddings m " +
          "JOIN events e ON e.id = m.event_id WHERE e.kind = ? AND e.external_id IS NOT NULL",
      )
      .all(kind) as unknown as { externalId: string; vector: Uint8Array }[];
    const out = new Map<string, Float32Array>();
    for (const row of rows) {
      // Copy to a fresh, aligned buffer before viewing as float32.
      const buf = row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength);
      out.set(row.externalId, new Float32Array(buf));
    }
    return out;
  }

  /** Number of events of a kind — for cheap "what exists?" diagnostics. */
  count(kind: EventKind): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = ?").get(kind) as { n: number };
    return row.n;
  }

  /**
   * Per-file churn: how many distinct commits touched each file at or after `sinceIso`.
   * One grouped query over the commit events — the raw material for the hotspot report.
   */
  churnByFile(sinceIso: string): Map<string, number> {
    const rows = this.db
      .prepare(
        "SELECT f.path AS path, COUNT(DISTINCT e.id) AS n FROM events e " +
          "JOIN event_files f ON f.event_id = e.id " +
          "WHERE e.kind = 'commit' AND e.occurred_at >= ? GROUP BY f.path",
      )
      .all(sinceIso) as unknown as { path: string; n: number }[];
    return new Map(rows.map((r) => [r.path, r.n]));
  }

  /** Record that a PR has been mined at a given updated_at (any outcome, incl. no decision). */
  markPrMined(externalId: string, updatedAt: string): void {
    this.markPrMinedRow(externalId, updatedAt);
  }

  private markPrMinedRow(externalId: string, updatedAt: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO mined_prs (external_id, updated_at) VALUES (?, ?)")
      .run(externalId, updatedAt);
  }

  /**
   * Persist mined decision events AND mark their source PRs mined in ONE transaction, so a crash
   * can never leave a PR flagged mined whose decision was never stored (a silent-loss gap the
   * miner would otherwise skip on re-run) — or the reverse. Returns how many events were newly
   * inserted. `keel mine` calls this per PR, keeping incremental progress crash-atomic.
   */
  appendManyAndMark(events: KeelEvent[], marks: { externalId: string; updatedAt: string }[]): number {
    let inserted = 0;
    this.transaction(() => {
      for (const event of events) if (this.insertOne(event)) inserted++;
      for (const m of marks) this.markPrMinedRow(m.externalId, m.updatedAt);
    });
    return inserted;
  }

  /** PR external_id -> the updated_at it was last mined at (for incremental skip decisions). */
  minedPrs(): Map<string, string> {
    const rows = this.db.prepare("SELECT external_id AS externalId, updated_at AS updatedAt FROM mined_prs").all() as unknown as {
      externalId: string;
      updatedAt: string;
    }[];
    return new Map(rows.map((r) => [r.externalId, r.updatedAt]));
  }

  /**
   * Remove an event and its dependent rows (linked files, embedding). The schema has no ON DELETE
   * CASCADE, so we clean up explicitly. Used to re-ingest an edited source (an ADR whose content
   * changed) — delete the stale event, then append the new one.
   */
  deleteEvent(kind: EventKind, externalId: string): void {
    this.transaction(() => this.deleteEventRow(kind, externalId));
  }

  private deleteEventRow(kind: EventKind, externalId: string): void {
    const row = this.db.prepare("SELECT id FROM events WHERE kind = ? AND external_id = ?").get(kind, externalId) as
      | { id: number | bigint }
      | undefined;
    if (!row) return;
    this.db.prepare("DELETE FROM embeddings WHERE event_id = ?").run(row.id);
    this.db.prepare("DELETE FROM event_files WHERE event_id = ?").run(row.id);
    this.db.prepare("DELETE FROM events WHERE id = ?").run(row.id);
  }

  /**
   * Delete stale events and append their replacements in ONE transaction — so re-ingesting an
   * edited source (e.g. an ADR whose content changed) can't crash between the delete and the
   * re-append, leaving the old record gone and the new one never written. Returns newly inserted.
   */
  replaceEvents(remove: { kind: EventKind; externalId: string }[], append: KeelEvent[]): number {
    let inserted = 0;
    this.transaction(() => {
      for (const r of remove) this.deleteEventRow(r.kind, r.externalId);
      for (const event of append) if (this.insertOne(event)) inserted++;
    });
    return inserted;
  }

  /** Mark a decision suppressed (a human "reject"); kept in the log, excluded from results. */
  suppressDecision(externalId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO suppressed_decisions (external_id) VALUES (?)").run(externalId);
  }

  /** External ids of all suppressed decisions. */
  suppressedDecisions(): Set<string> {
    const rows = this.db.prepare("SELECT external_id AS externalId FROM suppressed_decisions").all() as unknown as {
      externalId: string;
    }[];
    return new Set(rows.map((r) => r.externalId));
  }

  private hydrate(row: EventRow): KeelEvent {
    const files = (
      this.db.prepare("SELECT path FROM event_files WHERE event_id = ? ORDER BY path").all(row.id) as {
        path: string;
      }[]
    ).map((f) => f.path);
    const event: KeelEvent = {
      kind: row.kind as EventKind,
      occurredAt: row.occurred_at,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
    };
    if (row.external_id !== null) event.externalId = row.external_id;
    if (row.actor !== null) event.actor = row.actor;
    if (row.title !== null) event.title = row.title;
    if (files.length > 0) event.files = files;
    return event;
  }

  private transaction(fn: () => void): void {
    // BEGIN IMMEDIATE takes the write lock up front, so a concurrent writer waits out
    // busy_timeout at BEGIN rather than failing partway through on a lock upgrade.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}
