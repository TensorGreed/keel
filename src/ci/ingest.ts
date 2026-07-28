/**
 * CI connector: ingest JUnit test reports into the event log as `ci_run` events. Plain ETL —
 * no model calls (CLAUDE.md). One `keel ci` invocation = one CI run (which may be sharded across
 * several report files); the per-test results are stored so flaky detection can later spot a test
 * that both passed and failed on the same commit.
 *
 * Idempotent: a run's external_id is its --run-id, or (when unset) the commit sha plus a hash of
 * the report contents — so re-ingesting the same reports is a no-op, while a *re-run* with
 * different results (a flip) hashes differently and is recorded as a distinct observation. The
 * events carry the touched test files, so a file's CI history joins the graph.
 */
import { createHash } from "node:crypto";
import type { KeelEvent } from "../events/store.js";
import type { SqliteEventStore } from "../events/sqlite-store.js";
import { parseJUnit, type TestCaseResult, type TestStatus } from "./junit.js";

/** Stable identity for a test across runs: its file + name when the file is known, else name. */
export function testKey(file: string | undefined, name: string): string {
  return file ? `${file}::${name}` : name;
}

/** A single test observation stored in a ci_run payload. */
export interface StoredTestResult {
  name: string;
  file?: string;
  status: TestStatus;
}

export interface CiIngestOptions {
  /** the run's unique id (e.g. $GITHUB_RUN_ID); derived from sha + content hash when omitted */
  runId?: string;
  /** the commit the run tested (the flaky signal groups by this) */
  sha?: string;
  /** ISO timestamp for the run; falls back to a report timestamp, then now */
  timestamp?: string;
  /** wall clock for the fallback timestamp — injected for deterministic tests */
  now?: string;
}

export interface CiIngestResult {
  runId: string;
  sha: string | null;
  reports: number;
  tests: number;
  failed: number;
  skipped: number;
  /** distinct test files seen */
  files: number;
  /** 1 if the run was newly recorded, 0 if it was already ingested (idempotent) */
  ingested: number;
}

function isFailing(status: TestStatus): boolean {
  return status === "failed" || status === "error";
}

/** Build the ci_run event for a set of parsed reports. */
export function ciRunEvent(
  runId: string,
  sha: string | null,
  occurredAt: string,
  results: StoredTestResult[],
): KeelEvent {
  const failed = results.filter((r) => isFailing(r.status)).length;
  const files = [...new Set(results.map((r) => r.file).filter((f): f is string => Boolean(f)))];
  const event: KeelEvent = {
    kind: "ci_run",
    externalId: `ci:${runId}`,
    occurredAt,
    title: `CI run ${runId}: ${results.length} test(s), ${failed} failed`,
    payload: {
      runId,
      sha,
      total: results.length,
      failed,
      tests: results,
    },
  };
  if (files.length > 0) event.files = files;
  return event;
}

/**
 * Ingest a run's JUnit reports (each `{ path, xml }`) into the store as one ci_run event.
 * Errors — an unparseable report yields no tests — surface as data via the counts, never a throw.
 */
export function ingestCiReports(
  store: SqliteEventStore,
  reports: { path: string; xml: string }[],
  options: CiIngestOptions = {},
): CiIngestResult {
  const results: StoredTestResult[] = [];
  let reportTimestamp: string | undefined;
  for (const { xml } of reports) {
    const parsed = parseJUnit(xml);
    reportTimestamp ??= parsed.timestamp;
    for (const t of parsed.tests) {
      results.push({ name: t.name, ...(t.file ? { file: t.file } : {}), status: t.status });
    }
  }

  const sha = options.sha ?? null;
  const runId =
    options.runId ??
    `${sha ?? "nosha"}-${createHash("sha1").update(fingerprint(results)).digest("hex").slice(0, 12)}`;
  const occurredAt = options.timestamp ?? reportTimestamp ?? options.now ?? new Date().toISOString();

  const event = ciRunEvent(runId, sha, occurredAt, results);
  const ingested = store.appendMany([event]);

  return {
    runId,
    sha,
    reports: reports.length,
    tests: results.length,
    failed: results.filter((r) => isFailing(r.status)).length,
    skipped: results.filter((r) => r.status === "skipped").length,
    files: (event.files ?? []).length,
    ingested,
  };
}

/** A content fingerprint of a run's results — identical results hash the same (idempotent),
 *  a flipped re-run hashes differently (a new observation). Order-independent. */
function fingerprint(results: StoredTestResult[]): string {
  return results
    .map((r) => `${testKey(r.file, r.name)}=${r.status}`)
    .sort()
    .join("\n");
}
