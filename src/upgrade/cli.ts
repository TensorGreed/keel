/**
 * `keel upgrade` — the CLI over the upgrade core. A thin adapter: parse flags, open the event store
 * (for the flaky signal only), run the analysis, render.
 *
 * Exit codes follow `keel verdict`, so this drops into CI the same way: 0 pass, 2 warn, 1 block or
 * error. A blocking upgrade is a real answer, not a tool failure — the difference between "this bump
 * breaks three tests" and "keel couldn't run" is the `error` field, and only the latter is exit 1
 * with no report.
 */
import * as path from "node:path";
import { SqliteEventStore } from "../events/sqlite-store.js";
import * as fs from "node:fs";
import { renderRepairStep, renderUpgradeReport } from "./report.js";
import { runRepairStep } from "./repair.js";
import { runUpgradeAnalysis } from "./upgrade.js";

const UPGRADE_HELP = `keel upgrade — scope a dependency upgrade and prove what it breaks

Usage: keel upgrade <pkg>@<version|latest> [options]

  --json            emit the full structured report instead of the table
  --scope-only      graph analysis only: no install, no tests (fast, no network). Proves
                    nothing, so it withholds the verdict and always exits 2 — never 0.
  --max-tests N     cap the covering tests that run (default 50, or KEEL_MAX_TESTS)
  --max-seconds N   wall-clock cap for install + tests (default 300, or KEEL_MAX_SECONDS)

Repair loop (one failure at a time; YOU write the patch, keel proves it):
  --repair          report the single next break with the context needed to fix it
  --patch FILE      a unified diff against HEAD — your repair so far — applied before the bump
  --attempt N       which attempt this is (default 1); keel stops issuing tasks past --max-attempts
  --max-attempts N  give up after this many attempts (default 10)

Finds every file importing the package, computes the blast radius and covering tests, then — in a
throwaway git worktree, never your checkout — applies ONLY the version bump, installs, and runs
those tests. Reports executed failures with a graph path back to the import site, install-time
breaks (peer-dependency conflicts, engine mismatches), known-flaky failures as discounted, and the
part of the surface no test covers.

REPORT ONLY: this phase attempts no repairs. Every failure is reported as a work item.

Exit codes: 0 pass, 2 warn, 1 block or error. With --repair: 0 green, 2 work remaining,
1 exhausted or blocked. Reads KEEL_REPO or the current directory.`;

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index >= 0 && index + 1 < argv.length) return argv[index + 1];
  const inline = argv.find((a) => a.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
}

/** Flags that consume the next argv entry — so `--max-tests 5` doesn't read `5` as the package. */
const VALUE_FLAGS = new Set(["--max-tests", "--max-seconds", "--patch", "--attempt", "--max-attempts"]);

/** The first non-flag argument: the upgrade target. */
export function firstPositional(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("-")) {
      if (VALUE_FLAGS.has(arg)) i++; // skip its value
      continue;
    }
    return arg;
  }
  return undefined;
}

function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export async function runUpgrade(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(UPGRADE_HELP);
    return 0;
  }

  const target = firstPositional(argv);
  if (!target) {
    console.error("[keel] usage: keel upgrade <pkg>@<version|latest>\n");
    console.error(UPGRADE_HELP);
    return 1;
  }

  const asJson = argv.includes("--json");
  const repoRoot = path.resolve(process.env["KEEL_REPO"] ?? process.cwd());
  const maxTests = positiveInt(flagValue(argv, "--max-tests"));
  const maxSeconds = positiveInt(flagValue(argv, "--max-seconds"));

  // The store is opened only for the flaky signal. If it isn't there, discounting is skipped and
  // every failure is reported at full weight — the conservative direction.
  let store: SqliteEventStore | undefined;
  try {
    store = new SqliteEventStore(path.join(repoRoot, ".keel", "events.db"));
  } catch {
    store = undefined;
  }

  try {
    if (argv.includes("--repair")) {
      return await repairStep(repoRoot, target, argv, asJson, store);
    }

    const report = await runUpgradeAnalysis(repoRoot, target, {
      ...(maxTests !== undefined ? { maxTests } : {}),
      ...(maxSeconds !== undefined ? { maxSeconds } : {}),
      ...(argv.includes("--scope-only") ? { scopeOnly: true } : {}),
      ...(store ? { store } : {}),
    });

    if ("error" in report) {
      if (asJson) console.log(JSON.stringify(report, null, 2));
      else console.error(`[keel] ${report.error}`);
      return 1;
    }

    console.log(asJson ? JSON.stringify(report, null, 2) : renderUpgradeReport(report));
    // A scope-only run withheld its verdict — it installed nothing and executed nothing. Returning
    // 0 would let `keel upgrade --scope-only` in a CI gate read as proof that the bump is safe, so
    // it exits 2 (warn): the closest truthful cell, and never mistakable for a pass.
    if (report.scopeOnly) return 2;
    return report.verdict.verdict === "pass" ? 0 : report.verdict.verdict === "warn" ? 2 : 1;
  } finally {
    store?.close();
  }
}

/** One turn of the repair loop: prove the caller's patch, hand back the next task (or GREEN). */
async function repairStep(
  repoRoot: string,
  target: string,
  argv: string[],
  asJson: boolean,
  store: SqliteEventStore | undefined,
): Promise<number> {
  const patchFile = flagValue(argv, "--patch");
  let patch: string | undefined;
  if (patchFile !== undefined) {
    try {
      patch = fs.readFileSync(patchFile, "utf8");
    } catch (err) {
      console.error(`[keel] cannot read --patch ${patchFile}: ${(err as Error).message}`);
      return 1;
    }
  }

  const step = await runRepairStep(repoRoot, target, {
    ...(patch !== undefined ? { patch } : {}),
    ...(positiveInt(flagValue(argv, "--attempt")) !== undefined ? { attempt: positiveInt(flagValue(argv, "--attempt"))! } : {}),
    ...(positiveInt(flagValue(argv, "--max-attempts")) !== undefined ? { maxAttempts: positiveInt(flagValue(argv, "--max-attempts"))! } : {}),
    ...(positiveInt(flagValue(argv, "--max-tests")) !== undefined ? { maxTests: positiveInt(flagValue(argv, "--max-tests"))! } : {}),
    ...(positiveInt(flagValue(argv, "--max-seconds")) !== undefined ? { maxSeconds: positiveInt(flagValue(argv, "--max-seconds"))! } : {}),
    ...(store ? { store } : {}),
  });

  if ("error" in step) {
    if (asJson) console.log(JSON.stringify(step, null, 2));
    else console.error(`[keel] ${step.error}`);
    return 1;
  }

  console.log(asJson ? JSON.stringify(step, null, 2) : renderRepairStep(step));
  // 0 only for green. "work" is 2 so a CI gate can't read an unfinished repair as success.
  return step.status === "green" ? 0 : step.status === "work" ? 2 : 1;
}
