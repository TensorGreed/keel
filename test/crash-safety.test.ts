/**
 * Crash-safety + concurrency for the SQLite event store (COMMIT 2 of the hardening sprint).
 *
 * These are integration tests: they spawn the REAL compiled store in child processes and either
 * SIGKILL one mid-write (a genuine crash) or run three at once against one db file. What they
 * prove: a kill mid-ingest / mid-mine never corrupts the db and resumes cleanly, and concurrent
 * writers never leak SQLITE_BUSY out to the caller (busy_timeout + WAL + BEGIN IMMEDIATE).
 *
 * The child imports from dist/, so a stale/missing build is rebuilt once in beforeAll (CI builds
 * first, so this is usually a no-op).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteEventStore } from "../src/events/sqlite-store.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const HARNESS = path.join(ROOT, "test", "fixtures", "crash", "harness.mjs");
const DIST_STORE = path.join(ROOT, "dist", "events", "sqlite-store.js");

/** Rebuild dist only if the store's compiled output is missing or older than its sources. */
function ensureBuilt(): void {
  const srcs = [
    path.join(ROOT, "src", "events", "sqlite-store.ts"),
    path.join(ROOT, "src", "util", "timeouts.ts"),
    path.join(ROOT, "src", "events", "store.ts"),
  ];
  const fresh =
    fs.existsSync(DIST_STORE) &&
    srcs.every((s) => !fs.existsSync(s) || fs.statSync(s).mtimeMs <= fs.statSync(DIST_STORE).mtimeMs);
  if (fresh) return;
  execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "ignore" });
}

let dir: string;
let dbPath: string;
beforeAll(() => ensureBuilt(), 120_000);
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-crash-"));
  dbPath = path.join(dir, ".keel", "events.db");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function spawnHarness(mode: string, count: number): ChildProcess {
  return spawn(process.execPath, [HARNESS, dbPath, mode, String(count)], { cwd: ROOT });
}

/** Resolve once the child has printed at least `n` stdout lines (so we kill it mid-run). */
function afterLines(child: ChildProcess, n: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let seen = 0;
    let buf = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n").length - 1;
      if (lines >= n && seen < n) {
        seen = n;
        resolve();
      }
    });
    child.on("exit", () => resolve()); // finished before reaching n — fine, we still assert state
    child.on("error", reject);
  });
}

/** SIGKILL the child and wait for the OS to reap it. */
function killAndWait(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.on("exit", () => resolve());
    child.kill("SIGKILL");
  });
}

/** Run a harness to normal completion, collecting stdout and asserting a clean exit. */
function runToEnd(mode: string, count: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnHarness(mode, count);
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr!.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

/** A strong "not corrupt" check via a fresh raw handle — node:sqlite is loaded after our store,
 *  so the experimental-warning patch is already installed. */
async function assertIntegrityOk(): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    expect(row.integrity_check).toBe("ok");
  } finally {
    db.close();
  }
}

describe("crash-safety: kill mid-ingest", () => {
  it("leaves no corruption and resumes cleanly after a SIGKILL", async () => {
    const child = spawnHarness("ingest", 40);
    await afterLines(child, 5); // let a few batches commit
    await killAndWait(child);

    // The db opens, integrity-checks clean, and holds a whole number of committed events —
    // never a torn transaction. WAL discards the frames of the write that was in flight.
    await assertIntegrityOk();
    const store = new SqliteEventStore(dbPath);
    const partial = store.count("commit");
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThanOrEqual(40);
    const events = await store.byKind("commit", 1000);
    expect(events).toHaveLength(partial);
    for (const e of events) expect(e.files?.length).toBe(1); // each committed event is whole
    store.close();

    // Re-run to completion: idempotent (INSERT OR IGNORE), so it fills in the rest exactly.
    const done = await runToEnd("ingest", 40);
    expect(done.code).toBe(0);
    const after = new SqliteEventStore(dbPath);
    expect(after.count("commit")).toBe(40);
    after.close();
    await assertIntegrityOk();
  }, 60_000);
});

describe("crash-safety: kill mid-mine", () => {
  it("never marks a PR mined without persisting its decision, and resumes cleanly", async () => {
    const child = spawnHarness("mine", 30);
    await afterLines(child, 4);
    await killAndWait(child);

    await assertIntegrityOk();
    const store = new SqliteEventStore(dbPath);
    const mined = store.minedPrs(); // pr-N -> updatedAt
    const decisionIds = new Set((await store.byKind("decision", 1000)).map((d) => d.externalId));
    // The atomic invariant: every mined mark has its decision event committed alongside it.
    for (const prId of mined.keys()) {
      expect(decisionIds.has(`decision:${prId}`)).toBe(true);
    }
    expect(mined.size).toBeGreaterThan(0); // real progress was made and survived
    store.close();

    // Resume to completion — all 30 decisions present, all marked, still consistent.
    const done = await runToEnd("mine", 30);
    expect(done.code).toBe(0);
    const after = new SqliteEventStore(dbPath);
    expect(after.count("decision")).toBe(30);
    expect(after.minedPrs().size).toBe(30);
    after.close();
    await assertIntegrityOk();
  }, 60_000);
});

describe("concurrency: three writers on one db", () => {
  it("serializes without leaking SQLITE_BUSY to any process", async () => {
    const PER = 60;
    const results = await Promise.all([runToEnd("hammer", PER), runToEnd("hammer", PER), runToEnd("hammer", PER)]);

    for (const r of results) {
      expect(r.code).toBe(0); // a SQLITE_BUSY escape would throw → non-zero exit
      expect(r.stderr).not.toMatch(/SQLITE_BUSY|database is locked/i);
    }
    // Every writer's rows landed (unique external ids, no lost updates), and the db is intact.
    const store = new SqliteEventStore(dbPath);
    expect(store.count("commit")).toBe(PER * 3);
    store.close();
    await assertIntegrityOk();
  }, 60_000);
});
