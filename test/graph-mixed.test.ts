import { beforeAll, describe, expect, it } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFileGraph, reportFor } from "../src/graph/dependencies.js";
import { initPythonScanner } from "../src/graph/python-scanner.js";

// One graph, two languages. TS and Python files coexist; edges stay within each language —
// keel does not model TS<->Python edges yet (see docs/architecture.md), and pretending it did
// would be dishonest.
const mixed = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mixed");

beforeAll(async () => {
  await initPythonScanner();
});

describe("mixed TS + Python repo", () => {
  it("holds both languages in one graph", () => {
    const g = buildFileGraph(mixed);
    expect(g.files).toEqual(expect.arrayContaining(["ts/app.ts", "ts/util.ts", "py/main.py", "py/mod.py"]));
  });

  it("keeps intra-language edges", () => {
    const g = buildFileGraph(mixed);
    expect(reportFor(g, "ts/app.ts").dependencies).toEqual(["ts/util.ts"]);
    expect(reportFor(g, "py/main.py").dependencies).toEqual(["py/mod.py"]);
  });

  it("draws no cross-language edges (honest: not modeled yet)", () => {
    const g = buildFileGraph(mixed);
    // Each file's dependents stay in its own language.
    expect(reportFor(g, "ts/util.ts").dependents).toEqual(["ts/app.ts"]);
    expect(reportFor(g, "py/mod.py").dependents).toEqual(["py/main.py"]);
    // No .ts file depends on a .py file, or vice-versa.
    for (const file of g.files) {
      const deps = reportFor(g, file).dependencies;
      const py = file.endsWith(".py");
      for (const dep of deps) expect(dep.endsWith(".py")).toBe(py);
    }
  });
});
