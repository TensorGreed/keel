/**
 * `keel evidence` — measure keel's own claims against reality.
 *
 * Today it measures test selection by fault injection (selection.ts). The command is named for the
 * category rather than the method because the same shape applies to every claim keel makes:
 * preflight's predicted failures against CI's actual ones, verdicts against what later broke. Those
 * need accumulated usage; this one needs nothing but the repo, which is why it comes first.
 */
import * as path from "node:path";
import { measureSelection } from "./selection.js";
import { renderSelectionEvidence } from "./report.js";

const EVIDENCE_HELP = `keel evidence — measure whether keel's test selection actually catches what breaks

Usage: keel evidence [selection] [options]

  --trials N      how many faults to inject (default 20)
  --seed N        the deterministic sequence to use (default 1); same seed, same measurement
  --include P     only mutate files under this prefix (repeatable, e.g. --include src/)
  --max-seconds N per-trial wall clock for the full suite (default 600)
  --json          emit the full structured result

Injects a small mechanical fault into a covered source file, runs the WHOLE test suite to find out
what really breaks, and checks whether keel's selection contained it. Reports the escape rate (a
failing test keel did not select — the number that matters) and selectivity (the share of the suite
it skipped — the benefit, worth nothing unless escapes are zero).

Runs in a throwaway git worktree; your working tree is never touched. Exit 1 if anything escaped.`;

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index >= 0 && index + 1 < argv.length) return argv[index + 1];
  return argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
}

function positiveInt(raw: string | undefined): number | undefined {
  const value = Number(raw);
  return raw !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/** Flags that consume the next argv entry — so `--trials 6` doesn't read `6` as the subcommand. */
const VALUE_FLAGS = new Set(["--trials", "--seed", "--include", "--max-seconds"]);

/** The first non-flag argument, skipping every flag's value. */
export function subcommandOf(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("-")) {
      if (VALUE_FLAGS.has(arg)) i++;
      continue;
    }
    return arg;
  }
  return undefined;
}

function allValues(argv: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === name && argv[i + 1] !== undefined) out.push(argv[i + 1]!);
  return out;
}

export async function runEvidence(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(EVIDENCE_HELP);
    return 0;
  }
  const sub = subcommandOf(argv) ?? "selection";
  if (sub !== "selection") {
    console.error(`[keel] evidence: unknown subcommand "${sub}" (only "selection" so far)`);
    return 1;
  }

  const repoRoot = path.resolve(process.env["KEEL_REPO"] ?? process.cwd());
  const asJson = argv.includes("--json");
  const include = allValues(argv, "--include");
  const maxSeconds = positiveInt(flagValue(argv, "--max-seconds"));

  const result = await measureSelection(repoRoot, {
    ...(positiveInt(flagValue(argv, "--trials")) !== undefined ? { trials: positiveInt(flagValue(argv, "--trials"))! } : {}),
    ...(positiveInt(flagValue(argv, "--seed")) !== undefined ? { seed: positiveInt(flagValue(argv, "--seed"))! } : {}),
    ...(maxSeconds !== undefined ? { timeoutMs: maxSeconds * 1000 } : {}),
    ...(include.length > 0 ? { include } : {}),
    // A full suite per trial is slow; say what is happening rather than going quiet for minutes.
    ...(asJson ? {} : { onTrial: (trial, i, total) => process.stderr.write(`[keel] trial ${i}/${total} ${trial.outcome.padEnd(10)} ${trial.file} (${Math.round(trial.durationMs / 1000)}s)\n`) }),
  });

  if ("error" in result) {
    if (asJson) console.log(JSON.stringify(result, null, 2));
    else console.error(`[keel] ${result.error}`);
    return 1;
  }

  console.log(asJson ? JSON.stringify(result, null, 2) : renderSelectionEvidence(result));
  // An escape is the one outcome that invalidates the selection story — fail on it.
  return result.summary.escaped > 0 ? 1 : 0;
}
