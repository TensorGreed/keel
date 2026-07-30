/**
 * The bump itself: rewrite the worktree's package.json to the requested version, install, and read
 * back what the install actually said.
 *
 * This is the ONE place in keel where a package install runs, and it only ever runs inside a
 * throwaway sandbox worktree — never against the user's checkout. It's also why the upgrade sandbox
 * doesn't share the host's node_modules: the entire point is a different dependency tree, and a link
 * to the already-installed version would quietly test the thing we're trying to replace.
 *
 * Install output is a first-class source of breaks, not noise. A peer-dependency conflict or an
 * engine mismatch means the bump is unsafe whether or not a test fails — and npm reports both as
 * *warnings* on a run that exits zero, so the output is scanned regardless of exit code. (Which also
 * means the install must NOT be quietened with `--loglevel=error`: that would suppress exactly the
 * signals we came for.)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveOnPath, spawnSpec } from "../util/platform.js";
import { execFileTimed } from "../util/timeouts.js";

/** Dependency sections a package can be declared in, in the order npm resolves them. */
const DEP_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
type DepSection = (typeof DEP_SECTIONS)[number];

export type InstallSignalKind = "peer-conflict" | "engine-mismatch" | "install-failed";

export interface InstallSignal {
  kind: InstallSignalKind;
  /** one line, the summary a report row shows */
  message: string;
  /** the matching lines from npm's own output — the receipt */
  evidence: string[];
}

export interface BumpResult {
  /** the section package.json declared it in, or null when it wasn't declared at all */
  section: DepSection | null;
  /** the specifier that was there before */
  from: string | null;
  /** the specifier written in */
  to: string;
  /** the version actually installed, read back from node_modules (null if it isn't there) */
  installedVersion: string | null;
  /** npm's combined stdout+stderr, capped */
  output: string;
  /** npm's exit code (null if it never ran or was killed) */
  exitCode: number | null;
  signals: InstallSignal[];
  /** set when the install could not be attempted or completed at all */
  error?: string;
}

const OUTPUT_CAP = 16_000;

/** Where a package is declared in a manifest, and as what. */
export function findDeclaration(manifest: unknown, pkg: string): { section: DepSection; spec: string } | null {
  if (typeof manifest !== "object" || manifest === null) return null;
  for (const section of DEP_SECTIONS) {
    const deps = (manifest as Record<string, unknown>)[section];
    if (typeof deps !== "object" || deps === null) continue;
    const spec = (deps as Record<string, unknown>)[pkg];
    if (typeof spec === "string") return { section, spec };
  }
  return null;
}

/**
 * npm's install output, read for the two things that make a bump unsafe before a single test runs.
 * Matched on npm's stable error codes rather than prose, with the matching lines kept as evidence so
 * a reader can check the claim.
 */
export function readInstallSignals(output: string, exitCode: number | null): InstallSignal[] {
  const lines = output.split("\n");
  const signals: InstallSignal[] = [];

  // ERESOLVE — npm either overrode a peer requirement or refused to resolve one. Both mean the
  // dependency tree the bump asks for isn't the one the package says it needs.
  const eresolve = lines.filter((l) => /\bERESOLVE\b/.test(l) || /Could not resolve dependency/.test(l) || /^\s*npm (warn|error)\s+peer\b/.test(l));
  if (eresolve.length > 0) {
    const peer = lines.find((l) => /^\s*npm (warn|error)\s+peer\b/.test(l))?.trim();
    signals.push({
      kind: "peer-conflict",
      message: peer
        ? `peer dependency conflict: ${peer.replace(/^\s*npm (warn|error)\s+/, "")}`
        : "peer dependency conflict (npm reported ERESOLVE)",
      evidence: eresolve.map((l) => l.trim()).slice(0, 12),
    });
  }

  // EBADENGINE — the installed version declares an engine range this runtime doesn't satisfy. npm
  // logs it as a warning on a zero-exit install, so nothing but scanning would catch it.
  const engine = lines.filter((l) => /\bEBADENGINE\b/.test(l) || /Unsupported engine/.test(l));
  if (engine.length > 0) {
    const required = lines.find((l) => /required:/.test(l))?.trim();
    signals.push({
      kind: "engine-mismatch",
      message: `engine mismatch: the installed version does not support this runtime${required ? ` (${required.replace(/^npm warn EBADENGINE\s*/, "")})` : ""}`,
      evidence: engine.map((l) => l.trim()).slice(0, 12),
    });
  }

  if (exitCode !== null && exitCode !== 0) {
    const errors = lines.filter((l) => /^\s*npm error\b/.test(l)).map((l) => l.trim());
    signals.push({
      kind: "install-failed",
      message: `npm install failed (exit ${exitCode})${errors[0] ? `: ${errors[0].replace(/^npm error\s*/, "")}` : ""}`,
      evidence: errors.slice(0, 12),
    });
  }
  return signals;
}

/** Write `pkg@spec` into the worktree's package.json, returning what was there before. */
function writeBump(worktree: string, pkg: string, spec: string): { section: DepSection | null; from: string | null } | { error: string } {
  const manifestPath = path.join(worktree, "package.json");
  let manifest: Record<string, unknown>;
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
    manifest = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    return { error: `cannot read ${path.basename(manifestPath)}: ${(err as Error).message}` };
  }

  const existing = findDeclaration(manifest, pkg);
  // An undeclared package goes into `dependencies` — an upgrade of something reached transitively is
  // still a real question, and pinning it there is what a developer would do to answer it.
  const section: DepSection = existing?.section ?? "dependencies";
  const deps = (manifest[section] as Record<string, string> | undefined) ?? {};
  deps[pkg] = spec;
  manifest[section] = deps;

  // Preserve the file's indentation so the diff a reader might inspect stays minimal.
  const indent = /^\{\n(\s+)"/.exec(raw)?.[1] ?? "  ";
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, indent)}\n`);
  return { section: existing?.section ?? null, from: existing?.spec ?? null };
}

/** The version npm actually put on disk, from the installed package's own manifest. */
function readInstalledVersion(worktree: string, pkg: string): string | null {
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(worktree, "node_modules", ...pkg.split("/"), "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof installed.version === "string" ? installed.version : null;
  } catch {
    return null;
  }
}

/**
 * Apply the bump in `worktree` and install. Bounded by `budgetMs` and routed through the shared
 * timed-exec helper, so an install that hangs on a slow registry is killed and reported rather than
 * stalling the run (docs: "no hangs, ever").
 */
export async function bumpAndInstall(
  worktree: string,
  pkg: string,
  spec: string,
  budgetMs: number,
): Promise<BumpResult> {
  const empty: Omit<BumpResult, "error"> = {
    section: null,
    from: null,
    to: spec,
    installedVersion: null,
    output: "",
    exitCode: null,
    signals: [],
  };

  const written = writeBump(worktree, pkg, spec);
  if ("error" in written) return { ...empty, error: written.error };

  const npm = resolveOnPath("npm"); // PATHEXT-aware, so this finds npm.cmd on Windows
  if (!npm) return { ...empty, section: written.section, from: written.from, error: "npm is not on PATH — `keel upgrade` needs it to install the bumped version" };

  // Deliberately NOT --loglevel=error: peer conflicts and engine mismatches are warnings, and they
  // are exactly what we came to read. --no-audit/--no-fund only drop registry chatter we never use.
  const spec2 = spawnSpec(npm, ["install", "--no-audit", "--no-fund"]);
  let output = "";
  let exitCode: number | null = 0;
  let error: string | undefined;
  try {
    const { stdout, stderr } = await execFileTimed(spec2.command, spec2.args, {
      cwd: worktree,
      timeoutMs: budgetMs,
      maxBuffer: 32 * 1024 * 1024,
      label: `npm install ${pkg}@${spec}`,
      ...(spec2.shell ? { shell: true } : {}),
    });
    output = `${stdout}\n${stderr}`;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: unknown; message?: string };
    output = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    exitCode = typeof e.code === "number" ? e.code : null;
    // A timeout has no exit code and no npm error lines — surface it as the error, not as a signal.
    if (exitCode === null) error = e.message ?? "npm install did not complete";
  }

  const capped = output.length > OUTPUT_CAP ? `${output.slice(0, OUTPUT_CAP)}\n… (install log truncated)` : output;
  return {
    section: written.section,
    from: written.from,
    to: spec,
    installedVersion: readInstalledVersion(worktree, pkg),
    output: capped.trim(),
    exitCode,
    signals: readInstallSignals(capped, exitCode),
    ...(error ? { error } : {}),
  };
}
