/**
 * Cold-start battery: keel's graph over four real, pinned open-source repos — one per supported
 * language.
 *
 * Why this exists. Nothing in keel's development has found more real bugs than pointing it at a
 * repo nobody wrote a fixture for: Java's same-package modeling, `src/` layout detection by
 * convention, the 50-projects-in-one-package fusion, pytest's conftest aborts. Hand-written
 * fixtures encode what we already understood; a real repo encodes what we didn't. Those findings
 * were one-off manual runs, so nothing stopped a later change from quietly undoing them. This
 * makes them permanent — drift insurance, run weekly.
 *
 * Not in the default suite: it clones from the network and takes minutes. Run it with
 * `npm run test:coldstart` (see .github/workflows/coldstart.yml, which opens an issue on failure).
 *
 * ## The invariants, and why these shapes
 *
 * Every repo is pinned to a **SHA**, so the numbers below are reproducible, not approximate. They
 * are still asserted as *bands* rather than equalities, because the thing under test is keel, not
 * the repo: a resolution improvement that legitimately finds a few more edges should pass, while a
 * collapse (an empty graph, a scanner that stopped registering) or an explosion (containment
 * broken, so unrelated files fuse) should fail. A band is what distinguishes those.
 *
 *   - **File count** — catches a scanner that stopped seeing its language, and a walker that
 *     started descending into `node_modules`/`vendor`.
 *   - **Blast radius of a named core file** — the number the flight simulator is built on. A
 *     collapse to 0 means resolution broke; a jump to "everything" means the graph fused.
 *   - **Test selection for a seeded change** — the real code path (`getImpact` on the working
 *     tree → `changedRoots` → `selectTests`), asserted both non-empty *and* selective: a
 *     selection that reaches every test file in the repo is the same as having no selection.
 *   - **Edge provenance** — Go and Java must show `package` adjacency edges; losing them is how
 *     the Java same-package finding would silently regress.
 *
 * ## Refreshing the numbers
 *
 * Bumping a pin is a deliberate act: change the SHA, run `npm run test:coldstart`, and update
 * `expect` in the table from the reported actuals. A number that moved without a pin change is a
 * finding, not a stale expectation — investigate before you edit it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildFileGraph, transitiveDependents, type FileGraph } from "../../src/graph/dependencies.js";
import { resetGraphCache } from "../../src/graph/cache.js";
import { initGraphScanners } from "../../src/graph/scanners.js";
import { getImpact } from "../../src/simulate/impact.js";
import { changedRoots, isTestFile, selectTests } from "../../src/simulate/select-tests.js";
import { execFileTimed } from "../../src/util/timeouts.js";

interface ColdStartRepo {
  name: string;
  language: string;
  url: string;
  /** pinned commit — never a branch, so every number here is reproducible */
  sha: string;
  /** what that pin resolves to, measured, with the tolerance each number is asserted at */
  expect: {
    files: number;
    /** the extension that must dominate the graph, and the minimum share it must hold */
    dominantExt: { ext: string; minShare: number };
    /** a core file and its measured transitive-dependent count */
    blastRadius: { file: string; dependents: number };
    /** a leaf-ish file whose change must select some tests, but not all of them */
    seededChange: { file: string; append: string };
    /** edge kinds that must appear at all (Go/Java package adjacency); empty for import-only langs */
    requiredEdgeKinds: string[];
  };
}

/** ±15% on counts: wide enough for an honest resolution improvement, narrow enough that a
 *  collapse or a fusion fails. */
const COUNT_TOLERANCE = 0.15;
/** ±25% on blast radius, which moves more readily than a file count when resolution improves. */
const RADIUS_TOLERANCE = 0.25;

const REPOS: ColdStartRepo[] = [
  {
    name: "hono",
    language: "TypeScript",
    url: "https://github.com/honojs/hono",
    sha: "020e6ba7e9d58d10d12ee4a4d1ec41408577e71c", // v4.6.3
    expect: {
      files: 350,
      dominantExt: { ext: ".ts", minShare: 0.7 },
      blastRadius: { file: "src/hono.ts", dependents: 177 },
      seededChange: { file: "src/utils/url.ts", append: "\nexport const KEEL_COLDSTART_PROBE = 1;\n" },
      requiredEdgeKinds: [],
    },
  },
  {
    name: "flask",
    language: "Python",
    url: "https://github.com/pallets/flask",
    sha: "85039283fc3e986cced4ab39a3fe2b39314d06bb", // 3.0.3
    expect: {
      files: 82,
      dominantExt: { ext: ".py", minShare: 0.99 },
      blastRadius: { file: "src/flask/app.py", dependents: 68 },
      seededChange: { file: "src/flask/wrappers.py", append: "\nKEEL_COLDSTART_PROBE = 1\n" },
      requiredEdgeKinds: [],
    },
  },
  {
    name: "gin",
    language: "Go",
    url: "https://github.com/gin-gonic/gin",
    sha: "75ccf94d605a05fe24817fc2f166f6f2959d5cea", // v1.10.0
    expect: {
      files: 91,
      dominantExt: { ext: ".go", minShare: 0.99 },
      blastRadius: { file: "context.go", dependents: 22 },
      seededChange: { file: "binding/binding.go", append: "\nconst keelColdStartProbe = 1\n" },
      // A Go import targets a package: every non-test .go file of it must be an adjacency edge.
      requiredEdgeKinds: ["package"],
    },
  },
  {
    name: "spring-petclinic",
    language: "Java (Spring)",
    url: "https://github.com/spring-projects/spring-petclinic",
    sha: "f182358d02e4a68e52bdbabf55ca7800288511e7",
    expect: {
      files: 49,
      dominantExt: { ext: ".java", minShare: 0.99 },
      blastRadius: { file: "src/main/java/org/springframework/samples/petclinic/model/BaseEntity.java", dependents: 39 },
      seededChange: {
        file: "src/main/java/org/springframework/samples/petclinic/owner/Owner.java",
        append: "\n// keel cold-start probe\n",
      },
      // Same-package Java types reference each other with no import — losing this edge kind is
      // exactly how the finding that motivated it would regress.
      requiredEdgeKinds: ["package"],
    },
  },
];

/** Clones are cached between runs (they're pinned, so they can't go stale) — set
 *  KEEL_COLDSTART_DIR to keep them somewhere durable and make local reruns instant. */
const CACHE_DIR = process.env["KEEL_COLDSTART_DIR"] ?? path.join(os.tmpdir(), "keel-coldstart");
const CLONE_TIMEOUT_MS = 300_000;

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileTimed("git", args, { cwd, timeoutMs: CLONE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, label: `git ${args[0]}` });
}

/** A shallow checkout of exactly `sha`. Fetching one commit keeps each clone to a few MB. */
async function ensureClone(repo: ColdStartRepo): Promise<string> {
  const dir = path.join(CACHE_DIR, repo.name);
  const stamp = path.join(dir, ".keel-coldstart-sha");
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8").trim() === repo.sha) return dir;

  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  fs.mkdirSync(dir, { recursive: true });
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["remote", "add", "origin", repo.url]);
  await git(dir, ["fetch", "-q", "--depth", "1", "origin", repo.sha]);
  await git(dir, ["checkout", "-q", "FETCH_HEAD"]);
  fs.writeFileSync(stamp, `${repo.sha}\n`);
  return dir;
}

/** Assert `actual` is within `tolerance` of the measured `expected`, reporting both. */
function expectWithin(actual: number, expected: number, tolerance: number, what: string): void {
  const low = Math.floor(expected * (1 - tolerance));
  const high = Math.ceil(expected * (1 + tolerance));
  expect(
    actual >= low && actual <= high,
    `${what}: got ${actual}, expected ${expected} ±${Math.round(tolerance * 100)}% (${low}–${high}). ` +
      `If the pin didn't change, this is a finding — investigate before updating the table.`,
  ).toBe(true);
}

beforeAll(async () => {
  await initGraphScanners();
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}, 120_000);

describe.each(REPOS)("cold start: $name ($language)", (repo) => {
  let dir: string;
  let graph: FileGraph;

  beforeAll(async () => {
    dir = await ensureClone(repo);
    resetGraphCache();
    graph = buildFileGraph(dir);
    // eslint-disable-next-line no-console -- the actuals are the point when a band fails
    console.log(`[coldstart] ${repo.name}@${repo.sha.slice(0, 8)}: ${graph.files.length} files`);
  }, 600_000);

  afterAll(() => {
    // Leave the clone (it's pinned and cached); drop only what keel wrote into it.
    if (dir) fs.rmSync(path.join(dir, ".keel"), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("sees the repo's source tree, dominated by its own language", () => {
    expectWithin(graph.files.length, repo.expect.files, COUNT_TOLERANCE, `${repo.name} file count`);
    const { ext, minShare } = repo.expect.dominantExt;
    const share = graph.files.filter((f) => f.endsWith(ext)).length / graph.files.length;
    expect(share, `${ext} share of the graph`).toBeGreaterThanOrEqual(minShare);
    // Nothing vendored or built may enter the graph, whatever the walker does.
    expect(graph.files.filter((f) => /(^|\/)(node_modules|vendor|dist|build)\//.test(f))).toEqual([]);
  });

  it("computes a stable blast radius for a core file", () => {
    const { file, dependents } = repo.expect.blastRadius;
    expect(graph.files, `${file} must be in the graph`).toContain(file);
    const actual = transitiveDependents(graph, file).length;
    expectWithin(actual, dependents, RADIUS_TOLERANCE, `${file} transitive dependents`);
    // A blast radius that reaches the whole repo is indistinguishable from having no graph.
    expect(actual).toBeLessThan(graph.files.length);
  });

  it("selects covering tests for a seeded change — some, and not all", async () => {
    const { file, append } = repo.expect.seededChange;
    const target = path.join(dir, file);
    const original = fs.readFileSync(target, "utf8");
    try {
      fs.writeFileSync(target, original + append);
      resetGraphCache();
      // The real path a caller takes: working-tree impact, then selection over the changed roots.
      const impact = await getImpact(dir);
      if ("error" in impact) throw new Error(`getImpact failed: ${impact.error}`);
      expect(impact.changedFiles.map((c) => c.path)).toContain(file);

      const selection = selectTests(graph, changedRoots(impact.changedFiles));
      const totalTests = graph.files.filter(isTestFile).length;
      expect(selection.tests.length, `${file} must select at least one covering test`).toBeGreaterThan(0);
      expect(selection.tests.length, `${file} selected every one of the ${totalTests} test files — that isn't selection`)
        .toBeLessThan(totalTests);
    } finally {
      fs.writeFileSync(target, original);
      resetGraphCache();
    }
  }, 600_000);

  it("records the edge provenance its language model requires", () => {
    const kinds = new Set<string>();
    for (const targets of graph.edgeKind.values()) for (const kind of targets.values()) kinds.add(kind);
    for (const required of repo.expect.requiredEdgeKinds) {
      expect([...kinds], `${repo.name} must still produce "${required}" edges`).toContain(required);
    }
  });
});

/**
 * The 50-projects-in-one-package finding, pinned. A samples monorepo where unrelated projects all
 * declare `package com.example` must NOT fuse into one unit: adjacency is scoped to the build
 * module (nearest pom.xml / build.gradle ancestor), so projectA and projectB share a package name
 * and share no edges. Uses the in-repo fixture — no clone, so this half runs offline.
 */
describe("cold start: Java package adjacency never crosses a build module", () => {
  const FIXTURE = path.resolve(import.meta.dirname, "..", "fixtures", "java-samples-build");

  beforeAll(async () => {
    await initGraphScanners();
  });

  it("keeps two same-package projects in separate units", () => {
    resetGraphCache();
    const graph = buildFileGraph(FIXTURE);
    const inA = graph.files.filter((f) => f.startsWith("projectA/"));
    const inB = graph.files.filter((f) => f.startsWith("projectB/"));
    expect(inA.length).toBeGreaterThan(0);
    expect(inB.length).toBeGreaterThan(0);

    const crossing: string[] = [];
    for (const [from, targets] of graph.imports) {
      const fromA = from.startsWith("projectA/");
      for (const to of targets) {
        if (fromA !== to.startsWith("projectA/")) crossing.push(`${from} -> ${to}`);
      }
    }
    expect(crossing, "an edge crossed a build-module boundary via a shared package name").toEqual([]);

    // And each project's own files DO see each other — the scoping must not have removed adjacency.
    for (const files of [inA, inB]) {
      const within = files.some((f) => (graph.imports.get(f)?.size ?? 0) > 0);
      expect(within, "same-module, same-package files must still be adjacent").toBe(true);
    }
  });
});
