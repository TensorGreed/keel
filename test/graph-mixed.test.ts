import { beforeAll, describe, expect, it } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFileGraph, reportFor, type FileGraph } from "../src/graph/dependencies.js";
import { initGraphScanners } from "../src/graph/scanners.js";

// One graph, three languages. TS, Python, and Go files coexist; edges stay within each language —
// keel does not model cross-language edges yet (see docs/architecture.md), and pretending it did
// would be dishonest.
const mixed = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mixed");

/** The language a repo-relative file belongs to, by extension. */
function langOf(file: string): "ts" | "py" | "go" {
  if (file.endsWith(".py") || file.endsWith(".pyi")) return "py";
  if (file.endsWith(".go")) return "go";
  return "ts";
}

let g: FileGraph;
beforeAll(async () => {
  await initGraphScanners();
  g = buildFileGraph(mixed);
});

describe("mixed TS + Python + Go repo", () => {
  it("holds all three languages in one graph", () => {
    expect(g.files).toEqual(
      expect.arrayContaining([
        "ts/app.ts", "ts/util.ts",
        "py/main.py", "py/mod.py",
        "go/app/app.go", "go/lib/lib.go",
      ]),
    );
  });

  it("keeps intra-language edges", () => {
    expect(reportFor(g, "ts/app.ts").dependencies).toEqual(["ts/util.ts"]);
    expect(reportFor(g, "py/main.py").dependencies).toEqual(["py/mod.py"]);
    expect(reportFor(g, "go/app/app.go").dependencies).toEqual(["go/lib/lib.go"]);
  });

  it("keeps intra-language dependents", () => {
    expect(reportFor(g, "ts/util.ts").dependents).toEqual(["ts/app.ts"]);
    expect(reportFor(g, "py/mod.py").dependents).toEqual(["py/main.py"]);
    expect(reportFor(g, "go/lib/lib.go").dependents).toEqual(["go/app/app.go"]);
  });

  it("draws no cross-language edges (honest: not modeled yet)", () => {
    // Every dependency a file has shares that file's language — no TS<->Py<->Go edges.
    for (const file of g.files) {
      for (const dep of reportFor(g, file).dependencies) {
        expect(langOf(dep)).toBe(langOf(file));
      }
    }
  });
});
