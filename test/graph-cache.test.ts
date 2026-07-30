import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildFileGraph,
  deserializeFileGraph,
  reportFor,
  serializeFileGraph,
} from "../src/graph/dependencies.js";
import { loadGraph, resetGraphCache } from "../src/graph/cache.js";
import { rmDir } from "./helpers/platform.js";

// --- serialization ----------------------------------------------------------

describe("graph serialization", () => {
  it("round-trips a graph through JSON", () => {
    const original = buildFileGraph(path.join(__dirname, "fixtures", "symbols"));
    const restored = deserializeFileGraph(JSON.parse(JSON.stringify(serializeFileGraph(original))));
    expect(restored).not.toBeNull();
    for (const file of original.files) {
      expect(reportFor(restored!, file)).toEqual(reportFor(original, file));
    }
  });

  it("rejects an incompatible version", () => {
    const data = serializeFileGraph(buildFileGraph(path.join(__dirname, "fixtures", "sample")));
    expect(deserializeFileGraph({ ...data, version: 999 })).toBeNull();
  });

  it("rejects malformed data", () => {
    expect(deserializeFileGraph("nonsense")).toBeNull();
    expect(deserializeFileGraph({ version: 1 })).toBeNull();
  });
});

// --- git-keyed cache --------------------------------------------------------

function git(dir: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Dev",
      GIT_AUTHOR_EMAIL: "dev@example.com",
      GIT_COMMITTER_NAME: "Dev",
      GIT_COMMITTER_EMAIL: "dev@example.com",
      GIT_AUTHOR_DATE: "2021-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2021-01-01T00:00:00Z",
    },
  });
}

function write(dir: string, rel: string, contents: string): void {
  const target = path.join(dir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function commitAll(dir: string, message: string): void {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", message]);
}

/** A repo where b imports a, and c stands alone. */
function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-graph-"));
  git(dir, ["init", "-b", "main"]);
  write(dir, "a.ts", "export const a = 1;\n");
  write(dir, "b.ts", 'import { a } from "./a.js";\nexport const b = a + 1;\n');
  write(dir, "c.ts", "export const c = 3;\n");
  commitAll(dir, "initial");
  return dir;
}

/** The loaded graph must always equal a fresh full build of the working tree. */
async function assertMatchesFullBuild(dir: string): Promise<void> {
  const { graph } = await loadGraph(dir);
  const full = buildFileGraph(dir);
  expect(graph.files).toEqual(full.files);
  for (const file of full.files) {
    expect(reportFor(graph, file)).toEqual(reportFor(full, file));
  }
}

describe("git-keyed graph cache", () => {
  let dir: string;

  beforeEach(() => {
    resetGraphCache();
    dir = initRepo();
  });
  afterEach(() => {
    rmDir(dir);
  });

  it("rebuilds on first load, then serves from disk when HEAD is unchanged", async () => {
    const first = await loadGraph(dir);
    expect(first.source).toBe("rebuild");
    expect(fs.existsSync(path.join(dir, ".keel", "graph.json"))).toBe(true);

    resetGraphCache();
    const second = await loadGraph(dir);
    expect(second.source).toBe("disk");
    expect(reportFor(second.graph, "a.ts").dependents).toEqual(["b.ts"]);
  });

  it("reuses the in-memory memo within an unchanged working tree", async () => {
    await loadGraph(dir);
    expect((await loadGraph(dir)).source).toBe("memory");
  });

  it("updates incrementally when only file contents change", async () => {
    await loadGraph(dir); // prime disk cache at the initial commit

    // Repoint b from a to c — a pure modification (no files added or removed).
    write(dir, "b.ts", 'import { c } from "./c.js";\nexport const b = c + 1;\n');
    commitAll(dir, "repoint b to c");
    resetGraphCache();

    const load = await loadGraph(dir);
    expect(load.source).toBe("incremental");
    expect(reportFor(load.graph, "b.ts").dependencies).toEqual(["c.ts"]);
    expect(reportFor(load.graph, "a.ts").dependents).toEqual([]);
    expect(reportFor(load.graph, "c.ts").dependents).toEqual(["b.ts"]);
    await assertMatchesFullBuild(dir);
  });

  it("recomputes exports of a modified file incrementally", async () => {
    await loadGraph(dir);
    write(dir, "a.ts", "export const a = 1;\nexport const extra = 2;\n");
    commitAll(dir, "add export to a");
    resetGraphCache();

    const load = await loadGraph(dir);
    expect(load.source).toBe("incremental");
    expect(reportFor(load.graph, "a.ts").exports).toEqual(["a", "extra"]);
  });

  it("falls back to a full rebuild when a source file is added", async () => {
    await loadGraph(dir);
    write(dir, "d.ts", 'import { a } from "./a.js";\nexport const d = a;\n');
    commitAll(dir, "add d");
    resetGraphCache();

    const load = await loadGraph(dir);
    expect(load.source).toBe("rebuild");
    expect(load.graph.files).toContain("d.ts");
    expect(reportFor(load.graph, "a.ts").dependents).toEqual(["b.ts", "d.ts"]);
  });

  it("falls back to a full rebuild when a source file is removed", async () => {
    await loadGraph(dir);
    fs.rmSync(path.join(dir, "c.ts"));
    commitAll(dir, "remove c");
    resetGraphCache();

    const load = await loadGraph(dir);
    expect(load.source).toBe("rebuild");
    expect(load.graph.files).not.toContain("c.ts");
  });

  it("falls back to a full rebuild when tsconfig changes", async () => {
    await loadGraph(dir);
    write(dir, "tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: "." } }));
    commitAll(dir, "add tsconfig");
    resetGraphCache();

    expect((await loadGraph(dir)).source).toBe("rebuild");
  });

  it("updates a dirty working tree incrementally without persisting it", async () => {
    await loadGraph(dir); // persist cache at the committed HEAD
    const committedHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();

    // Uncommitted edit: b no longer imports anything.
    write(dir, "b.ts", "export const b = 99;\n");
    resetGraphCache();

    const load = await loadGraph(dir);
    expect(load.source).toBe("incremental");
    expect(reportFor(load.graph, "a.ts").dependents).toEqual([]); // reflects the dirty edit
    await assertMatchesFullBuild(dir);

    // The persisted cache still corresponds to the clean committed HEAD, not the dirt.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, ".keel", "graph.json"), "utf8"));
    expect(onDisk.head).toBe(committedHead);
  });

  it("rebuilds when the on-disk cache is corrupt", async () => {
    await loadGraph(dir);
    fs.writeFileSync(path.join(dir, ".keel", "graph.json"), "{ not json");
    resetGraphCache();

    const load = await loadGraph(dir);
    expect(load.source).toBe("rebuild");
    expect(reportFor(load.graph, "a.ts").dependents).toEqual(["b.ts"]);
  });

  it("builds correctly for a non-git directory", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "keel-nogit-"));
    try {
      write(plain, "x.ts", 'import { y } from "./y.js";\nexport const x = y;\n');
      write(plain, "y.ts", "export const y = 1;\n");
      resetGraphCache();

      const load = await loadGraph(plain);
      expect(load.source).toBe("rebuild");
      expect(load.head).toBeNull();
      expect(reportFor(load.graph, "y.ts").dependents).toEqual(["x.ts"]);
      expect(fs.existsSync(path.join(plain, ".keel", "graph.json"))).toBe(false);
    } finally {
      rmDir(plain);
    }
  });
});

describe("incremental rescan over an import cycle", () => {
  let dir: string;

  beforeEach(() => {
    resetGraphCache();
  });
  afterEach(() => {
    if (dir) rmDir(dir);
  });

  it("updates a cyclic graph incrementally and still excludes each file from itself", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-cycle-"));
    git(dir, ["init", "-b", "main"]);
    write(dir, ".gitignore", ".keel/\n");
    write(dir, "a.ts", 'import { b } from "./b.js";\nexport const a = () => b() + 1;\n');
    write(dir, "b.ts", 'import { a } from "./a.js";\nexport const b = () => (a ? 1 : 0);\n');
    commitAll(dir, "cycle");

    await loadGraph(dir); // rebuild + persist the cyclic graph at HEAD

    // Modify only a.ts's body -> the incremental path rescans it over the cycle.
    write(dir, "a.ts", 'import { b } from "./b.js";\nexport const a = () => b() + 2;\n');
    commitAll(dir, "tweak a");
    resetGraphCache();

    const load = await loadGraph(dir);
    expect(load.source).toBe("incremental");
    // The cycle must not make a file its own transitive dependent, and must terminate.
    expect(reportFor(load.graph, "a.ts").transitiveDependents).toEqual(["b.ts"]);
    expect(reportFor(load.graph, "b.ts").transitiveDependents).toEqual(["a.ts"]);
    await assertMatchesFullBuild(dir);
  }, 10_000);
});
