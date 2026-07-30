/**
 * Central timeout policy for every outbound call keel makes: GitHub HTTP, Ollama (generate +
 * embed), Anthropic/OpenAI-compatible model calls, git subprocesses, and test runners. One
 * module owns the defaults and their `KEEL_*_TIMEOUT` env overrides so no call site invents
 * its own budget (or forgets one) — see test/timeout-audit.test.ts, which fails the build if a
 * new fetch/execFile call site bypasses these helpers.
 *
 * Every env override is in seconds (matching the pre-existing KEEL_HTTP_TIMEOUT convention),
 * converted to ms here.
 */
import { execFile, execFileSync } from "node:child_process";

/** Anything that can plausibly run past this without a peep is required to log progress. */
export const PROGRESS_THRESHOLD_MS = 5_000;

function envSecondsToMs(name: string, defaultMs: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultMs;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : defaultMs;
}

/** GitHub REST calls (list/get/post). */
export function httpTimeoutMs(): number {
  return envSecondsToMs("KEEL_HTTP_TIMEOUT", 30_000);
}

/** git subprocess calls (log, rev-parse, remote, diff, worktree, …). */
export function gitTimeoutMs(): number {
  return envSecondsToMs("KEEL_GIT_TIMEOUT", 20_000);
}

/** Ollama /api/generate (decision mining). */
export function ollamaGenerateTimeoutMs(): number {
  return envSecondsToMs("KEEL_OLLAMA_TIMEOUT", 60_000);
}

/** How long a SQLite writer waits on SQLITE_BUSY before giving up (server + hook + `keel mine`
 *  can all open the same db concurrently). Milliseconds directly (not seconds — this one is
 *  sub-second-precision-sensitive), default 5s. */
export function sqliteBusyTimeoutMs(): number {
  const raw = process.env["KEEL_SQLITE_BUSY_TIMEOUT_MS"];
  if (raw === undefined || raw === "") return 5_000;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 5_000;
}

/** Ollama /api/embed (decision + query embedding). */
export function ollamaEmbedTimeoutMs(): number {
  return envSecondsToMs("KEEL_OLLAMA_EMBED_TIMEOUT", 20_000);
}

/** Anthropic / any OpenAI-compatible /chat/completions endpoint (offline mining only). */
export function modelTimeoutMs(): number {
  return envSecondsToMs("KEEL_MODEL_TIMEOUT", 60_000);
}

/** Sandboxed test-runner processes (vitest/jest/node/pytest/go/mvn/gradle). */
export function runnerTimeoutMs(): number {
  return envSecondsToMs("KEEL_RUNNER_TIMEOUT", 120_000);
}

/**
 * Run `op`, writing a one-line stderr note if it hasn't settled after `thresholdMs` — so a
 * slow-but-not-yet-timed-out call (a cold Ollama model load, a big git log) tells the terminal
 * it's still working instead of going quiet. Never affects the result or the timeout itself;
 * purely observational.
 */
export async function withProgress<T>(
  label: string,
  op: () => Promise<T>,
  thresholdMs: number = PROGRESS_THRESHOLD_MS,
): Promise<T> {
  let settled = false;
  const timer = setTimeout(() => {
    if (!settled) process.stderr.write(`[keel] still waiting: ${label}...\n`);
  }, thresholdMs);
  try {
    return await op();
  } finally {
    settled = true;
    clearTimeout(timer);
  }
}

export interface ExecFileTimedOptions {
  cwd?: string;
  maxBuffer?: number;
  timeoutMs?: number;
  /** label for the progress note; defaults to `git <args[0]>` */
  label?: string;
  /** if set, written to the child's stdin and closed (e.g. piping a diff to `git apply`) */
  input?: string;
  /** run through a shell — required on Windows for a .cmd/.bat shim (see util/platform.spawnSpec) */
  shell?: boolean;
}

/**
 * git (or any) subprocess with a mandatory timeout and >5s progress note. Node's `execFile`
 * `timeout` option SIGTERMs the child and rejects with `err.killed === true`; this normalizes
 * that into a clear, resumable message instead of a raw ETIMEDOUT-ish stack.
 */
export function execFileTimed(
  command: string,
  args: string[],
  opts: ExecFileTimedOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = opts.timeoutMs ?? gitTimeoutMs();
  const label = opts.label ?? `${command} ${args[0] ?? ""}`.trim();
  return withProgress(label, () => execFileTimedRaw(command, args, opts, timeoutMs), PROGRESS_THRESHOLD_MS).catch(
    (err: unknown) => {
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
      if (e.code === "ETIMEDOUT" || (e.killed && (e.signal === "SIGTERM" || e.signal === undefined))) {
        throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s (raise KEEL_GIT_TIMEOUT to allow longer)`);
      }
      throw err;
    },
  );
}

function execFileTimedRaw(
  command: string,
  args: string[],
  opts: ExecFileTimedOptions,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { cwd: opts.cwd, maxBuffer: opts.maxBuffer, timeout: timeoutMs, killSignal: "SIGTERM", ...(opts.shell ? { shell: true } : {}) },
      (err, stdout, stderr) => {
        if (err) {
          (err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }).stdout = stdout;
          (err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }).stderr = stderr;
          reject(err);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** fetch with an AbortSignal.timeout and a >5s progress note, sharing one call shape across all HTTP call sites. */
export function fetchTimed(url: string, init: RequestInit, timeoutMs: number, label: string): Promise<Response> {
  return withProgress(label, () => fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }), PROGRESS_THRESHOLD_MS);
}

/**
 * Synchronous git (or any) subprocess with a mandatory timeout, for the few call sites that
 * are themselves synchronous CLI paths. Prefer execFileTimed (async) elsewhere.
 */
export function execFileSyncTimed(command: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): string {
  const timeoutMs = opts.timeoutMs ?? gitTimeoutMs();
  try {
    return execFileSync(command, args, { cwd: opts.cwd, timeout: timeoutMs }).toString();
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
    if (e.code === "ETIMEDOUT" || (e.killed && (e.signal === "SIGTERM" || e.signal === undefined))) {
      throw new Error(`${command} ${args[0] ?? ""} timed out after ${Math.round(timeoutMs / 1000)}s (raise KEEL_GIT_TIMEOUT to allow longer)`);
    }
    throw err;
  }
}
