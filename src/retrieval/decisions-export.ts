/**
 * The one place that writes `.keel-decisions.jsonl` from a command, with its user-facing message.
 *
 * Separated from decisions-file.ts so every writer — `keel mine`, `keel decision add/reject`,
 * `keel ingest` — reports the same thing the same way, and so a failure to write the export can
 * never fail the command that produced the decision. The decision is already in the event log by
 * the time this runs; losing the export costs a re-run, losing the decision would cost a model pass.
 */
import type { SqliteEventStore } from "../events/sqlite-store.js";
import { DECISIONS_FILE, exportDecisions } from "./decisions-file.js";

export async function writeDecisionExport(store: SqliteEventStore, repoRoot: string): Promise<void> {
  try {
    const result = await exportDecisions(store, repoRoot);
    if (result.changed) {
      console.log(
        `[keel] wrote ${DECISIONS_FILE} (${result.records} decision(s), ${result.suppressed} suppressed) — ` +
          `commit it and your team's agents get this memory with no mining`,
      );
    }
  } catch (err) {
    process.stderr.write(`[keel] could not write ${DECISIONS_FILE}: ${(err as Error).message} (the decisions themselves are saved)\n`);
  }
}
