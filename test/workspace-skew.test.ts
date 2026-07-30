import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { looseSatisfies, versionSkewWarnings } from "../src/workspace/skew.js";
import type { WorkspaceMember } from "../src/workspace/config.js";
import { rmDir } from "./helpers/platform.js";

// Version skew: the workspace graph describes the CHECKOUTS, so keel warns when a member's checked-out
// version doesn't satisfy what a sibling declares as its dependency constraint (TS/JS, cheap check).

describe("looseSatisfies (dependency-free version check)", () => {
  it("honors ^, ~, exact and treats ranges / workspace protocols as satisfied", () => {
    // caret: same major satisfies, different major doesn't
    expect(looseSatisfies("1.5.0", "^1.0.0")).toBe(true);
    expect(looseSatisfies("2.0.0", "^1.0.0")).toBe(false);
    // ^0.x pins the minor
    expect(looseSatisfies("0.2.0", "^0.1.0")).toBe(false);
    // tilde: major.minor
    expect(looseSatisfies("1.2.9", "~1.2.0")).toBe(true);
    expect(looseSatisfies("1.3.0", "~1.2.0")).toBe(false);
    // exact
    expect(looseSatisfies("1.0.0", "1.0.0")).toBe(true);
    expect(looseSatisfies("1.0.1", "1.0.0")).toBe(false);
    // permissive: ranges, wildcards, and the workspace/file protocols never warn
    expect(looseSatisfies("9.9.9", ">=1.0.0")).toBe(true);
    expect(looseSatisfies("3.1.4", "*")).toBe(true);
    expect(looseSatisfies("3.1.4", "workspace:*")).toBe(true);
    expect(looseSatisfies("3.1.4", "file:../lib")).toBe(true);
  });
});

describe("versionSkewWarnings", () => {
  const tmps: string[] = [];
  function memberDir(pkg: Record<string, unknown>): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "keel-skew-"));
    tmps.push(d);
    fs.writeFileSync(path.join(d, "package.json"), JSON.stringify(pkg));
    return d;
  }
  afterEach(() => {
    while (tmps.length) rmDir(tmps.pop()!);
  });

  it("warns when a sibling's checkout doesn't satisfy the declared constraint", () => {
    const members: WorkspaceMember[] = [
      { name: "lib", root: memberDir({ name: "@acme/lib", version: "2.0.0" }) },
      { name: "app", root: memberDir({ name: "@acme/app", version: "1.0.0", dependencies: { "@acme/lib": "^1.0.0" } }) },
    ];
    const warnings = versionSkewWarnings(members);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("app depends on @acme/lib@^1.0.0");
    expect(warnings[0]).toContain("the lib checkout is 2.0.0");
    expect(warnings[0]).toContain("not the version resolved at runtime");
  });

  it("stays quiet when the checkout satisfies the constraint (or uses workspace:)", () => {
    const inRange: WorkspaceMember[] = [
      { name: "lib", root: memberDir({ name: "@acme/lib", version: "1.4.0" }) },
      { name: "app", root: memberDir({ name: "@acme/app", version: "1.0.0", dependencies: { "@acme/lib": "^1.0.0" } }) },
    ];
    expect(versionSkewWarnings(inRange)).toEqual([]);

    const wsProtocol: WorkspaceMember[] = [
      { name: "lib", root: memberDir({ name: "@acme/lib", version: "9.9.9" }) },
      { name: "app", root: memberDir({ name: "@acme/app", version: "1.0.0", dependencies: { "@acme/lib": "workspace:*" } }) },
    ];
    expect(versionSkewWarnings(wsProtocol)).toEqual([]);
  });

  it("ignores a dependency no sibling publishes", () => {
    const members: WorkspaceMember[] = [
      { name: "app", root: memberDir({ name: "@acme/app", version: "1.0.0", dependencies: { lodash: "^4.0.0" } }) },
    ];
    expect(versionSkewWarnings(members)).toEqual([]);
  });
});
