/**
 * The platform layer (src/util/platform.ts). These are the primitives the Windows CI leg depends
 * on, so each one is asserted on whatever platform the suite is running on — the shape of the
 * assertion branches, never the fact that it runs.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  canonicalPath,
  isBatchFile,
  IS_WINDOWS,
  linkDir,
  localPackageBin,
  quoteForCmd,
  resolveOnPath,
  spawnSpec,
  unlinkDir,
} from "../src/util/platform.js";
import { rmDir } from "./helpers/platform.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-platform-"));
});
afterEach(() => rmDir(dir));

/** Write a file that PATH resolution should find for the bare name `name` on this platform. */
function writeExecutable(inDir: string, name: string): string {
  const file = path.join(inDir, IS_WINDOWS ? `${name}.cmd` : name);
  fs.writeFileSync(file, IS_WINDOWS ? "@echo off\r\n" : "#!/bin/sh\n");
  if (!IS_WINDOWS) fs.chmodSync(file, 0o755);
  return file;
}

describe("resolveOnPath", () => {
  it("finds a bare command name on PATH, with the platform's executable extension", () => {
    const expected = writeExecutable(dir, "keeltool");
    expect(resolveOnPath("keeltool", { PATH: dir })).toBe(expected);
  });

  it("returns null for a name that isn't there", () => {
    expect(resolveOnPath("keeltool-does-not-exist", { PATH: dir })).toBeNull();
  });

  it("searches PATH entries in order", () => {
    const first = path.join(dir, "first");
    const second = path.join(dir, "second");
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    const winner = writeExecutable(first, "keeltool");
    writeExecutable(second, "keeltool");
    expect(resolveOnPath("keeltool", { PATH: [first, second].join(path.delimiter) })).toBe(winner);
  });

  it("never searches the current directory — a repo file must not shadow an installed tool", () => {
    writeExecutable(dir, "keeltool");
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      expect(resolveOnPath("keeltool", { PATH: "" })).toBeNull();
    } finally {
      process.chdir(cwd);
    }
  });

  it("treats a path-shaped argument as a path, not a PATH lookup", () => {
    const file = writeExecutable(dir, "keeltool");
    expect(resolveOnPath(file, { PATH: "" })).toBe(file);
    expect(resolveOnPath(path.join(dir, "nope"), { PATH: "" })).toBeNull();
  });
});

describe("isBatchFile / quoteForCmd", () => {
  it("recognizes the Windows shims that need a shell, case-insensitively", () => {
    expect(isBatchFile("C:\\tools\\mvn.cmd")).toBe(true);
    expect(isBatchFile("C:\\tools\\gradlew.BAT")).toBe(true);
    expect(isBatchFile("C:\\tools\\go.exe")).toBe(false);
    expect(isBatchFile("/usr/bin/go")).toBe(false);
  });

  it("leaves a plain argument alone and quotes anything cmd.exe would re-interpret", () => {
    expect(quoteForCmd("test")).toBe("test");
    expect(quoteForCmd("-Dtest=Foo")).toBe('"-Dtest=Foo"'); // '=' is a cmd token separator
    expect(quoteForCmd("C:\\Program Files\\x\\mvn.cmd")).toBe('"C:\\Program Files\\x\\mvn.cmd"');
    expect(quoteForCmd('say "hi"')).toBe('"say ""hi"""');
    expect(quoteForCmd("")).toBe('""');
  });
});

describe("spawnSpec", () => {
  it("is the identity on POSIX and resolves-then-classifies on Windows", () => {
    const spec = spawnSpec("git", ["status"]);
    if (!IS_WINDOWS) {
      expect(spec).toEqual({ command: "git", args: ["status"], shell: false });
    } else {
      // git on a Windows runner is git.exe: resolved to an absolute path, no shell needed.
      expect(spec.shell).toBe(false);
      expect(spec.command.toLowerCase()).toMatch(/git(\.exe)?$/);
      expect(spec.args).toEqual(["status"]);
    }
  });

  it("passes an unresolvable name through untouched, so spawn reports the real spawn error", () => {
    const spec = spawnSpec("keeltool-does-not-exist", ["-v"]);
    expect(spec.command).toBe("keeltool-does-not-exist");
    expect(spec.shell).toBe(false);
  });

  it.skipIf(!IS_WINDOWS)("routes a .cmd shim through a shell, pre-quoted", () => {
    const shim = path.join(dir, "faketool.cmd");
    fs.writeFileSync(shim, "@echo off\r\n");
    const spec = spawnSpec(shim, ["-Dtest=A,B", "test"]);
    expect(spec.shell).toBe(true);
    expect(spec.command).toBe(quoteForCmd(shim));
    expect(spec.args).toEqual(['"-Dtest=A,B"', "test"]);
  });
});

describe("localPackageBin", () => {
  it("resolves the JS entry from a package's own bin field", () => {
    const pkgDir = path.join(dir, "node_modules", "faketest");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "faketest", bin: { faketest: "./cli.mjs" } }));
    fs.writeFileSync(path.join(pkgDir, "cli.mjs"), "");
    expect(localPackageBin(dir, "faketest", "faketest")).toBe(path.join(pkgDir, "cli.mjs"));
  });

  it("handles a string bin field, and returns null when the entry doesn't exist", () => {
    const pkgDir = path.join(dir, "node_modules", "faketest");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "faketest", bin: "cli.mjs" }));
    expect(localPackageBin(dir, "faketest", "faketest")).toBeNull(); // declared but not on disk
    fs.writeFileSync(path.join(pkgDir, "cli.mjs"), "");
    expect(localPackageBin(dir, "faketest", "faketest")).toBe(path.join(pkgDir, "cli.mjs"));
  });

  it("returns null for a package that isn't installed", () => {
    expect(localPackageBin(dir, "not-installed", "not-installed")).toBeNull();
  });

  it("resolves keel's real vitest — the path the JS sandbox runner actually takes", () => {
    const bin = localPackageBin(REPO_ROOT, "vitest", "vitest");
    expect(bin).not.toBeNull();
    expect(fs.existsSync(bin!)).toBe(true);
  });
});

describe("linkDir / unlinkDir", () => {
  it("shares a directory through a link and removes the link without touching the target", () => {
    const target = path.join(dir, "real");
    const link = path.join(dir, "linked");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "keep.txt"), "keep me");

    expect(linkDir(target, link)).toBe(true);
    expect(fs.readFileSync(path.join(link, "keep.txt"), "utf8")).toBe("keep me"); // readable through it
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true); // a junction reports as one too

    unlinkDir(link);
    expect(fs.existsSync(link)).toBe(false);
    // The point of the whole exercise: teardown must not follow the link into the shared tree.
    expect(fs.readFileSync(path.join(target, "keep.txt"), "utf8")).toBe("keep me");
  });

  it("is a no-op on a missing link and refuses to delete a real file", () => {
    const file = path.join(dir, "not-a-link.txt");
    fs.writeFileSync(file, "x");
    unlinkDir(path.join(dir, "absent"));
    unlinkDir(file);
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe("canonicalPath", () => {
  it("is idempotent and absolute", () => {
    const once = canonicalPath(dir);
    expect(path.isAbsolute(once)).toBe(true);
    expect(canonicalPath(once)).toBe(once);
  });

  it("puts a path and its realpath in the same space, so containment checks hold", () => {
    // The failure this guards: a repo whose root is reached via a symlink (or a Windows 8.3 short
    // name) while its files are realpath-ed during import resolution — every startsWith(root)
    // check fails and edges silently vanish.
    const real = path.join(dir, "real");
    const via = path.join(dir, "via");
    fs.mkdirSync(real);
    const file = path.join(real, "f.txt");
    fs.writeFileSync(file, "");
    if (!linkDir(real, via)) return; // no link privileges here; nothing to assert

    const root = canonicalPath(via);
    const seen = canonicalPath(path.join(via, "f.txt"));
    expect(seen.startsWith(root + path.sep)).toBe(true);
    expect(canonicalPath(file)).toBe(seen);
  });

  it("falls back to resolve for a path that doesn't exist yet", () => {
    const missing = path.join(dir, "nope", "deeper");
    expect(canonicalPath(missing)).toBe(path.resolve(missing));
  });
});
