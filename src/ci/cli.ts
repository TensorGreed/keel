/**
 * `keel ci` — ingest JUnit test reports from a CI run into the event log. Point it at the XML
 * your test runner produced (files or directories); one invocation records one run. Lazy-loaded
 * from index.ts so it doesn't pull in SQLite unless invoked.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { SqliteEventStore } from "../events/sqlite-store.js";
import { resolveHeadSha } from "../github/remote.js";
import { ingestCiReports } from "./ingest.js";

const CI_HELP = `keel ci — ingest JUnit test reports from a CI run into the event log

Usage: keel ci <report.xml | dir> [more...] [--sha SHA] [--run-id ID] [--timestamp ISO]

  <report.xml | dir>   JUnit XML file(s), or director(ies) searched for *.xml
  --sha SHA            the commit this run tested (default: git HEAD)
  --run-id ID          the run's unique id (default: sha + a hash of the reports)
  --timestamp ISO      when the run happened (default: a report timestamp, else now)

Re-ingesting the same reports is a no-op; a re-run with different results is recorded as a
new observation, which is how flaky tests (a pass and a fail on the same commit) surface.`;

const IGNORED = new Set(["node_modules", ".git", ".keel", "dist", "build"]);

function warn(message: string): void {
  process.stderr.write(`[keel] ${message}\n`);
}

/** Expand a path into JUnit report files: a file as-is, a directory searched for *.xml. */
function collectReports(target: string): string[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return [];
  }
  if (stat.isFile()) return [target];
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED.has(entry.name) && !entry.name.startsWith(".")) walk(path.join(dir, entry.name));
      } else if (entry.name.endsWith(".xml")) {
        found.push(path.join(dir, entry.name));
      }
    }
  };
  walk(target);
  return found;
}

export async function runCi(argv: string[]): Promise<number> {
  const targets: string[] = [];
  let sha: string | undefined;
  let runId: string | undefined;
  let timestamp: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      console.log(CI_HELP);
      return 0;
    }
    if (arg === "--sha" || arg === "--run-id" || arg === "--timestamp") {
      const value = argv[++i];
      if (value === undefined) {
        warn(`ci: ${arg} needs a value`);
        return 1;
      }
      if (arg === "--sha") sha = value;
      else if (arg === "--run-id") runId = value;
      else timestamp = value;
    } else if (arg.startsWith("-")) {
      warn(`ci: unknown option ${arg}`);
      return 1;
    } else {
      targets.push(arg);
    }
  }

  if (targets.length === 0) {
    warn("ci: give at least one JUnit report file or directory (see --help)");
    return 1;
  }

  const repoRoot = path.resolve(process.env["KEEL_REPO"] ?? process.cwd());
  const files = [...new Set(targets.flatMap(collectReports))];
  if (files.length === 0) {
    warn(`ci: no JUnit XML reports found in ${targets.join(", ")}`);
    return 1;
  }

  const reports: { path: string; xml: string }[] = [];
  for (const file of files) {
    try {
      reports.push({ path: file, xml: fs.readFileSync(file, "utf8") });
    } catch (err) {
      warn(`ci: cannot read ${file}: ${(err as Error).message}`);
      return 1;
    }
  }

  if (sha === undefined) {
    const head = await resolveHeadSha(repoRoot);
    if (typeof head === "string") sha = head;
    else warn("ci: no git HEAD to attribute this run to; recording without a commit (pass --sha)");
  }

  const store = new SqliteEventStore(path.join(repoRoot, ".keel", "events.db"));
  try {
    const result = ingestCiReports(store, reports, {
      ...(sha !== undefined ? { sha } : {}),
      ...(runId !== undefined ? { runId } : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
    });
    const dedup = result.ingested === 0 ? " (already ingested — no change)" : "";
    console.log(
      `[keel] ci run ${result.runId}${result.sha ? ` @ ${result.sha.slice(0, 12)}` : ""}: ` +
        `${result.tests} test(s), ${result.failed} failed, ${result.skipped} skipped from ${result.reports} report(s)${dedup}`,
    );
    return 0;
  } finally {
    store.close();
  }
}
