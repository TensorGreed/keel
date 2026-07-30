/**
 * Registry test: every outbound call site (HTTP fetch, git/process subprocess) must go
 * through src/util/timeouts.ts. This is a static source scan, not a runtime check — it fails
 * the build the moment someone adds a raw `fetch(`/`execFile(`/`spawn(` call outside that
 * module, instead of relying on a reviewer to notice a missing timeout (see CLAUDE.md
 * principle "no flagship-model calls / never a hang").
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = path.resolve(import.meta.dirname, "../src");

/** The one file allowed to call the raw Node primitives directly — everything else must go
 *  through its exported helpers (fetchTimed, execFileTimed, execFileSyncTimed). */
const WRAPPER_FILE = path.join(SRC_ROOT, "util", "timeouts.ts");

/**
 * sandbox.ts's `spawn(...)` for the test-runner child process is exempted: it isn't a
 * fire-and-forget outbound call, it's the flight simulator's own process supervision, already
 * timeout-bounded by its own `timer`/`opts.timeoutMs` (see runProcess) with a >5s progress
 * note — an equivalent contract to execFileTimed, just shaped for streaming stdout/stderr
 * instead of a single buffered result.
 */
const SANDBOX_SPAWN_FILE = path.join(SRC_ROOT, "simulate", "sandbox.ts");

const FORBIDDEN_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "raw fetch(", re: /(?<![.\w])fetch\(/g },
  { name: "raw execFile(", re: /(?<![.\w])execFile\(/g },
  { name: "raw execFileSync(", re: /(?<![.\w])execFileSync\(/g },
  { name: "raw spawnSync(", re: /(?<![.\w])spawnSync\(/g },
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("timeout audit: every outbound call site declares a timeout", () => {
  it("has no raw fetch/execFile/execFileSync/spawnSync call outside the timeouts wrapper", () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(SRC_ROOT)) {
      if (file === WRAPPER_FILE) continue;
      const content = fs.readFileSync(file, "utf8");
      for (const { name, re } of FORBIDDEN_PATTERNS) {
        re.lastIndex = 0;
        if (re.test(content)) offenders.push(`${path.relative(SRC_ROOT, file)}: ${name}`);
      }
    }
    expect(offenders, "add the timeout via src/util/timeouts.ts instead of calling the raw primitive").toEqual([]);
  });

  it("sandbox.ts's own spawn() is the only exempted process-supervision call, and stays timeout-bounded", () => {
    const content = fs.readFileSync(SANDBOX_SPAWN_FILE, "utf8");
    expect(content).toMatch(/import\s*\{\s*spawn\s*\}\s*from\s*"node:child_process"/);
    // The spawned child must be killed on a timer, not left to run unbounded — and the kill has to
    // take the whole tree, since on Windows the runner sits under a cmd.exe shim whose death would
    // otherwise leave the real build (java, go, …) running.
    expect(content).toMatch(/setTimeout\(\(\)\s*=>\s*\{[^}]*killTree\(child\)/);
    expect(content).toMatch(/function killTree\([\s\S]*?child\.kill\(/);
  });

  it("src/util/timeouts.ts exports a timeout getter for every category the audit covers", () => {
    const content = fs.readFileSync(WRAPPER_FILE, "utf8");
    for (const fn of [
      "httpTimeoutMs",
      "gitTimeoutMs",
      "ollamaGenerateTimeoutMs",
      "ollamaEmbedTimeoutMs",
      "modelTimeoutMs",
      "runnerTimeoutMs",
    ]) {
      expect(content, `missing ${fn} export`).toContain(`export function ${fn}`);
    }
  });
});
