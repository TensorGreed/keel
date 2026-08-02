/**
 * `keel watch` — the graph pre-warm.
 *
 * The watcher is an optimisation, so the bar it has to clear is that it changes *when* work happens
 * and never *what the answer is*. That makes one property load-bearing: after a refresh, the graph
 * must equal a fresh full `buildFileGraph` of the working tree — the same incremental-equals-full
 * guarantee the cache itself carries (graph-cache.test.ts). A pre-warm that warmed a wrong graph
 * would be far worse than no pre-warm, because every subsequent tool call would serve it from the
 * memo without ever rebuilding.
 *
 * The rest is about not being a nuisance: the filter must not wake on `.keel/` (which is where the
 * cache is written — a watcher that retriggered itself would spin forever), and the handle must
 * never hold a process open or run two rebuilds at once.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildFileGraph, reportFor } from "../src/graph/dependencies.js";
import { loadGraph, resetGraphCache } from "../src/graph/cache.js";
import { initGraphScanners } from "../src/graph/scanners.js";
import { isWatchRelevant, recursiveWatchSupported, startGraphWatcher, type WatchEvent, type Watcher } from "../src/watch/watcher.js";
import { rmDir } from "./helpers/platform.js";

const SUPPORTED = recursiveWatchSupported(os.tmpdir());

let dir: string;
let watcher: Watcher | null = null;

function git(args: string[]): void {
  execFileSync("git", args, {
    cwd: dir,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e.com",
      GIT_AUTHOR_DATE: "2021-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2021-01-01T00:00:00Z",
    },
  });
}

function write(rel: string, contents: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
}

beforeAll(async () => {
  await initGraphScanners();
});
beforeEach(() => {
  resetGraphCache();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-watch-"));
  fs.writeFileSync(path.join(dir, ".gitignore"), ".keel/\n");
  write("a.ts", "export const a = 1;\n");
  write("b.ts", "import { a } from './a.js';\nexport const b = a;\n");
  git(["init", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
});
afterEach(() => {
  watcher?.close();
  watcher = null;
  rmDir(dir);
});

/** Start the watcher and resolve on its next refresh (or reject on a deadline, never hang). */
function nextRefresh(timeoutMs = 10_000): { started: Promise<WatchEvent> } {
  let resolve!: (event: WatchEvent) => void;
  let reject!: (err: Error) => void;
  const started = new Promise<WatchEvent>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const deadline = setTimeout(() => reject(new Error(`no refresh within ${timeoutMs}ms`)), timeoutMs);
  watcher = startGraphWatcher(dir, {
    debounceMs: 30,
    onRefresh: (event) => {
      clearTimeout(deadline);
      resolve(event);
    },
    onError: (message) => {
      clearTimeout(deadline);
      reject(new Error(message));
    },
  });
  return { started };
}

/** The loaded graph must equal a fresh full build — the guarantee the cache makes, extended here. */
async function assertMatchesFullBuild(): Promise<void> {
  const { graph } = await loadGraph(dir);
  const full = buildFileGraph(dir);
  expect(graph.files).toEqual(full.files);
  for (const file of full.files) {
    expect(reportFor(graph, file), file).toEqual(reportFor(full, file));
  }
}

describe("what wakes the watcher", () => {
  it("wakes on source and on config, and never on its own cache directory", () => {
    expect(isWatchRelevant("src/a.ts")).toBe(true);
    expect(isWatchRelevant("pkg/main.py")).toBe(true);
    expect(isWatchRelevant("package.json")).toBe(true);
    expect(isWatchRelevant("go.mod")).toBe(true);

    // The cache is WRITTEN into .keel/ — waking on it would make the watcher retrigger itself.
    expect(isWatchRelevant(".keel/graph.json")).toBe(false);
    expect(isWatchRelevant(".git/index")).toBe(false);
    expect(isWatchRelevant("node_modules/left-pad/index.js")).toBe(false);
    expect(isWatchRelevant("dist/index.js")).toBe(false);

    // Not source, not config: a README churn shouldn't cost a rebuild.
    expect(isWatchRelevant("README.md")).toBe(false);
    expect(isWatchRelevant("")).toBe(false);
  });

  it("accepts a Windows-style separator, since that is what fs.watch reports there", () => {
    expect(isWatchRelevant("src\\a.ts")).toBe(true);
    expect(isWatchRelevant(".keel\\graph.json")).toBe(false);
  });
});

describe.skipIf(!SUPPORTED)("refreshing keeps the graph correct", () => {
  it("rebuilds after a file's contents change, and the result equals a full build", async () => {
    const { started } = nextRefresh();
    write("a.ts", "export const a = 1;\nexport const extra = 2;\n");
    const event = await started;

    expect(event.path).toBe("a.ts");
    expect(event.files).toBe(2);
    await assertMatchesFullBuild();
    expect(reportFor((await loadGraph(dir)).graph, "a.ts").exports).toEqual(["a", "extra"]);
  }, 30_000);

  it("rebuilds after a file is ADDED — the case that forces a full rebuild and costs the most", async () => {
    const { started } = nextRefresh();
    write("c.ts", "import { b } from './b.js';\nexport const c = b;\n");
    await started;

    await assertMatchesFullBuild();
    const { graph } = await loadGraph(dir);
    expect(graph.files).toContain("c.ts");
    expect(reportFor(graph, "b.ts").dependents).toEqual(["c.ts"]);
  }, 30_000);

  it("rebuilds after a file is REMOVED, dropping its edges", async () => {
    const { started } = nextRefresh();
    fs.rmSync(path.join(dir, "b.ts"));
    await started;

    await assertMatchesFullBuild();
    const { graph } = await loadGraph(dir);
    expect(graph.files).not.toContain("b.ts");
    expect(reportFor(graph, "a.ts").dependents).toEqual([]);
  }, 30_000);

  it("coalesces a burst of edits into one refresh rather than one per file", async () => {
    const events: WatchEvent[] = [];
    watcher = startGraphWatcher(dir, { debounceMs: 120, onRefresh: (e) => events.push(e) });
    for (let i = 0; i < 5; i++) write(`burst${i}.ts`, `export const v${i} = ${i};\n`);
    await new Promise((r) => setTimeout(r, 1_500));

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.length, "a burst of five saves must not cost five rebuilds").toBeLessThan(5);
    await assertMatchesFullBuild();
  }, 30_000);

  it("stops refreshing once closed", async () => {
    const events: WatchEvent[] = [];
    watcher = startGraphWatcher(dir, { debounceMs: 30, onRefresh: (e) => events.push(e) });
    watcher.close();
    write("after-close.ts", "export const x = 1;\n");
    await new Promise((r) => setTimeout(r, 500));
    expect(events).toEqual([]);
  }, 30_000);
});

describe("the watcher never becomes the problem", () => {
  it("reports whether it is active instead of pretending", () => {
    watcher = startGraphWatcher(dir, { debounceMs: 30 });
    expect(watcher.active).toBe(SUPPORTED);
  });

  it("survives being closed twice", () => {
    watcher = startGraphWatcher(dir, { debounceMs: 30 });
    watcher.close();
    expect(() => watcher!.close()).not.toThrow();
  });

  it("degrades to a no-op on a path it cannot watch, rather than throwing", () => {
    const errors: string[] = [];
    const w = startGraphWatcher(path.join(dir, "does-not-exist"), { onError: (m) => errors.push(m) });
    expect(w.active).toBe(false);
    expect(errors.join(" ")).toContain("built on demand");
    w.close();
  });
});
