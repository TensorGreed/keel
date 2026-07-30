/**
 * Large-repo budget: keel's graph build over a synthetic ~24k-file, four-language repo.
 *
 * Not in the default suite (it writes ~24k files and takes tens of seconds). Run it with
 * `npm run test:perf`. The budgets it enforces are documented in docs/architecture.md.
 *
 * ## What this asserts, and why in this shape
 *
 * Absolute wall-clock ceilings on a shared CI runner are a poor primary signal: set them tight and
 * they flake on a noisy neighbour, set them loose and they never fire. So the load-bearing assertion
 * here is **relative**: build the same repo shape at ~6k and ~24k files and require the *per-file*
 * cost not to grow. That is machine-independent and it is precisely the regression that matters —
 * an accidentally quadratic pass (an all-pairs edge set, a repeated directory sweep, a containment
 * check that rescans) shows up as a rising per-file cost long before it shows up as a number a
 * human would question. Measured ratio at the time of writing: **1.01**.
 *
 * The absolute ceilings are kept as a catastrophe backstop, deliberately generous (roughly an order
 * of magnitude over measured) so that when one fires, something is genuinely broken rather than the
 * runner being slow.
 *
 * And a completeness check runs first, because the cheapest way to pass a perf test is to do less
 * work: the graph must contain every language's files and real edges for each before any timing
 * assertion means anything.
 */
import { beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildFileGraph, serializeFileGraph, type FileGraph } from "../../src/graph/dependencies.js";
import { resetGraphCache } from "../../src/graph/cache.js";
import { initGraphScanners } from "../../src/graph/scanners.js";
import { rmDir } from "../helpers/platform.js";

/** The full-size repo: ~24k files, weighted towards TypeScript as a real full-stack repo would be. */
const FULL = { ts: 8000, py: 5000, go: 4000, java: 3000 };
/** A quarter-scale copy of the same shape, for the linearity comparison. */
const SMALL = { ts: 2000, py: 1250, go: 1000, java: 750 };

// --- the budgets (see docs/architecture.md) ---------------------------------

/** Wall clock for one cold full build. Measured ~2.2s on a dev box; a CI runner is a few times
 *  slower. 60s is a catastrophe backstop, not a target. */
const MAX_BUILD_MS = 60_000;
/** Peak RSS for the process across BOTH builds (maxRSS is a process-wide high-water mark, so the
 *  quarter-scale build counts too). Measured ~680MB; 1.5GB leaves room for a slower runner's
 *  allocator behaviour without tolerating a leak or a quadratic edge set. */
const MAX_PEAK_RSS_MB = 1536;
/** The serialized graph — what lands in .keel/graph.json. Measured ~13.5MB. */
const MAX_CACHE_MB = 64;
/** Per-file build cost must not grow more than this from quarter-scale to full scale. Measured
 *  1.01×; a genuinely quadratic pass over a 4× size increase would land near 4×. */
const MAX_PER_FILE_GROWTH = 2.0;

interface Measurement {
  files: number;
  buildMs: number;
  perFileMs: number;
}

let dir: string;
let full: Measurement;
let small: Measurement;
let graph: FileGraph;
let cacheBytes: number;
let peakRssMb: number;

/** Build once, timing the best of three so a single GC pause doesn't decide the verdict. */
function measure(root: string): { measurement: Measurement; graph: FileGraph } {
  let best = Number.POSITIVE_INFINITY;
  let built: FileGraph | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    resetGraphCache();
    const started = Date.now();
    built = buildFileGraph(root);
    best = Math.min(best, Date.now() - started);
  }
  const files = built!.files.length;
  return { measurement: { files, buildMs: best, perFileMs: best / files }, graph: built! };
}

beforeAll(async () => {
  await initGraphScanners();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-perf-"));

  // All measuring happens here, in one place and one order, so the peak-RSS reading below covers
  // exactly these builds and nothing a later test happened to do.
  const { generateSynthRepo } = await import("./synth-repo.js");

  const smallRoot = path.join(dir, "small");
  generateSynthRepo(smallRoot, SMALL);
  small = measure(smallRoot).measurement;

  const fullRoot = path.join(dir, "full");
  const written = generateSynthRepo(fullRoot, FULL);
  const result = measure(fullRoot);
  full = result.measurement;
  graph = result.graph;

  cacheBytes = Buffer.byteLength(JSON.stringify(serializeFileGraph(graph)));
  // maxRSS is a true process peak (kilobytes), unlike memoryUsage().rss which is a snapshot.
  peakRssMb = process.resourceUsage().maxRSS / 1024;

  // The measurements are the deliverable when a budget fails, so always print them.
  console.log(
    `[perf] generated ${written} files\n` +
      `[perf] small: ${small.files} files in ${small.buildMs}ms (${small.perFileMs.toFixed(4)} ms/file)\n` +
      `[perf] full:  ${full.files} files in ${full.buildMs}ms (${full.perFileMs.toFixed(4)} ms/file)\n` +
      `[perf] per-file growth: ${(full.perFileMs / small.perFileMs).toFixed(3)}×\n` +
      `[perf] peak RSS ${peakRssMb.toFixed(0)}MB, serialized graph ${(cacheBytes / 1048576).toFixed(1)}MB`,
  );
}, 900_000);

describe("large-repo budget: ~24k files, four languages", () => {
  it("built a COMPLETE graph — every language present, with real edges", () => {
    // First, because the cheapest way to pass a perf budget is to do less work.
    expect(full.files).toBeGreaterThan(20_000);

    const counts = { ts: 0, py: 0, go: 0, java: 0 } as Record<string, number>;
    const edges = { ts: 0, py: 0, go: 0, java: 0 } as Record<string, number>;
    const langOf = (f: string): string | null =>
      f.endsWith(".ts") ? "ts" : f.endsWith(".py") ? "py" : f.endsWith(".go") ? "go" : f.endsWith(".java") ? "java" : null;
    for (const file of graph.files) {
      const lang = langOf(file);
      if (!lang) continue;
      counts[lang]!++;
      edges[lang]! += graph.imports.get(file)?.size ?? 0;
    }
    for (const lang of ["ts", "py", "go", "java"]) {
      expect(counts[lang], `${lang} files in the graph`).toBeGreaterThan(500);
      expect(edges[lang], `${lang} import edges`).toBeGreaterThan(counts[lang]! / 2);
    }
  });

  it("builds the whole graph within the wall-clock budget", () => {
    expect(
      full.buildMs,
      `full build took ${full.buildMs}ms for ${full.files} files (budget ${MAX_BUILD_MS}ms — a generous ` +
        `backstop, so exceeding it means something is broken, not that the runner is slow)`,
    ).toBeLessThan(MAX_BUILD_MS);
  });

  it("keeps per-file cost flat as the repo grows 4× — the real regression signal", () => {
    const growth = full.perFileMs / small.perFileMs;
    expect(
      growth,
      `per-file build cost grew ${growth.toFixed(2)}× from ${small.files} to ${full.files} files ` +
        `(budget ${MAX_PER_FILE_GROWTH}×). A quadratic pass over a 4× size increase lands near 4×: ` +
        `look for an all-pairs edge set, a repeated directory sweep, or a rescanning containment check.`,
    ).toBeLessThan(MAX_PER_FILE_GROWTH);
  });

  it("stays within the peak-memory budget", () => {
    expect(peakRssMb, `peak RSS ${peakRssMb.toFixed(0)}MB (budget ${MAX_PEAK_RSS_MB}MB)`).toBeLessThan(MAX_PEAK_RSS_MB);
  });

  it("serializes to a graph cache a repo can actually carry", () => {
    const mb = cacheBytes / 1048576;
    expect(mb, `serialized graph ${mb.toFixed(1)}MB (budget ${MAX_CACHE_MB}MB)`).toBeLessThan(MAX_CACHE_MB);
  });

  it("cleans up", () => {
    rmDir(dir);
    expect(fs.existsSync(dir)).toBe(false);
  });
});
