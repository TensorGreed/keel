import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_POLICY, globMatch, loadPolicy, parsePolicy } from "../src/trust/policy.js";

describe("globMatch", () => {
  it("matches * within a segment and ** across segments", () => {
    expect(globMatch("src/**/*.ts", "src/a/b.ts")).toBe(true);
    expect(globMatch("src/**/*.ts", "src/x.ts")).toBe(true);
    expect(globMatch("src/**/*.ts", "src/a/b.js")).toBe(false);
    expect(globMatch("src/**/*.ts", "lib/a.ts")).toBe(false);

    expect(globMatch("config/**", "config/a.json")).toBe(true);
    expect(globMatch("config/**", "config/nested/a.json")).toBe(true);
    expect(globMatch("config/**", "config")).toBe(false);
    expect(globMatch("config/**", "src/config/a.json")).toBe(false);
  });

  it("anchors exact and **-prefixed patterns", () => {
    expect(globMatch("package.json", "package.json")).toBe(true);
    expect(globMatch("package.json", "a/package.json")).toBe(false);
    expect(globMatch("**/package.json", "package.json")).toBe(true);
    expect(globMatch("**/package.json", "a/b/package.json")).toBe(true);
    expect(globMatch("src/*.ts", "src/a.ts")).toBe(true);
    expect(globMatch("src/*.ts", "src/a/b.ts")).toBe(false); // * does not cross "/"
  });
});

describe("parsePolicy", () => {
  it("accepts a valid policy and fills defaults for omitted fields", () => {
    expect(parsePolicy({ version: 1, requireSimPass: false })).toEqual({
      ...DEFAULT_POLICY,
      requireSimPass: false,
    });
  });

  it("rejects a wrong version, bad types, and malformed protectedPaths", () => {
    expect("error" in parsePolicy({ version: 2 })).toBe(true);
    expect("error" in parsePolicy({ version: 1, requireSimPass: "yes" })).toBe(true);
    expect("error" in parsePolicy({ version: 1, maxBlastRadius: -3 })).toBe(true);
    expect("error" in parsePolicy({ version: 1, protectedPaths: [{ glob: "x" }] })).toBe(true);
    expect("error" in parsePolicy("not an object")).toBe(true);
  });

  it("accepts null maxBlastRadius and well-formed protectedPaths", () => {
    const p = parsePolicy({ version: 1, maxBlastRadius: null, protectedPaths: [{ glob: "src/**", reason: "core" }] });
    expect(p).toMatchObject({ maxBlastRadius: null, protectedPaths: [{ glob: "src/**", reason: "core" }] });
  });
});

describe("loadPolicy", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-policy-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns conservative defaults when no file exists", () => {
    expect(loadPolicy(dir)).toEqual({ policy: DEFAULT_POLICY, source: "default" });
  });

  it("loads a valid file", () => {
    fs.writeFileSync(path.join(dir, "keel.policy.json"), JSON.stringify({ version: 1, maxBlastRadius: 10 }));
    const loaded = loadPolicy(dir);
    expect(loaded).toMatchObject({ source: "file", policy: { maxBlastRadius: 10 } });
  });

  it("returns an error (never a silent fallback) for malformed JSON", () => {
    fs.writeFileSync(path.join(dir, "keel.policy.json"), "{ not json");
    const loaded = loadPolicy(dir);
    expect("error" in loaded).toBe(true);
    if ("error" in loaded) expect(loaded.error).toContain("keel.policy.json");
  });
});
