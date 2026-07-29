/**
 * Crash-safety / concurrency harness for test/crash-safety.test.ts. Runs the REAL compiled
 * SqliteEventStore in a separate process so the parent can SIGKILL it mid-write (a true crash,
 * not a catchable throw) or run several copies at once to contend on one db file.
 *
 * Imports from dist/ because Node can't run keel's `.ts` sources directly (they use `.js` import
 * specifiers); the test builds dist first when it's stale. Usage:
 *   node harness.mjs <dbPath> <ingest|mine|hammer> <count>
 * Each unit of work prints a progress line to stdout so the parent knows when to pull the trigger.
 */
import { SqliteEventStore } from "../../../dist/events/sqlite-store.js";

const [dbPath, mode, countStr] = process.argv.slice(2);
const count = Number(countStr);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const store = new SqliteEventStore(dbPath);

if (mode === "ingest") {
  // One committed transaction per iteration, with a small gap so a kill lands between commits.
  for (let i = 0; i < count; i++) {
    store.appendMany([
      {
        kind: "commit",
        externalId: `commit:${i}`,
        occurredAt: "2021-01-01T00:00:00Z",
        title: `c${i}`,
        payload: { i },
        files: [`f${i}.ts`],
      },
    ]);
    process.stdout.write(`ingested ${i}\n`);
    await sleep(20);
  }
} else if (mode === "mine") {
  // Simulate `keel mine`: a fake-model delay (the window a kill lands in), then the atomic
  // decision-event + mined-mark write. The invariant under test: never a mark without its event.
  for (let i = 0; i < count; i++) {
    await sleep(30);
    store.appendManyAndMark(
      [
        {
          kind: "decision",
          externalId: `decision:pr-${i}`,
          occurredAt: "2021-01-01T00:00:00Z",
          title: `d${i}`,
          payload: { origin: "mined", prNumber: i, summary: `s${i}` },
          files: [`f${i}.ts`],
        },
      ],
      [{ externalId: `pr-${i}`, updatedAt: "2021-01-01T00:00:00Z" }],
    );
    process.stdout.write(`mined ${i}\n`);
  }
} else if (mode === "hammer") {
  // Tight loop of short write-transactions interleaved with reads, to contend with sibling
  // processes on the same WAL db. A SQLITE_BUSY that escaped busy_timeout would throw here and
  // exit the process non-zero — which the parent asserts never happens.
  const tag = process.pid;
  for (let i = 0; i < count; i++) {
    store.appendMany([
      { kind: "commit", externalId: `commit:${tag}-${i}`, occurredAt: "2021-01-01T00:00:00Z", title: "c", payload: {}, files: [] },
    ]);
    store.count("commit"); // a concurrent reader on the same handle
  }
  process.stdout.write(`hammer ${tag} done ${count}\n`);
} else {
  process.stderr.write(`unknown mode: ${mode}\n`);
  process.exit(2);
}

store.close();
