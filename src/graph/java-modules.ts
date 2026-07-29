/**
 * Java module scoping — shared by the Java scanner (import + same-package resolution) and the Spring
 * DI pass (candidate matching). A Java "module" bounds where same-package adjacency and resolution
 * apply, so a samples monorepo where 50 unrelated projects all declare `package com.example` doesn't
 * get fused into one giant unit (the CipherTrust cold-start finding).
 *
 * A file's module is, in order:
 *   1. the nearest ancestor directory holding a build file — pom.xml, build.gradle(.kts), or
 *      settings.gradle(.kts) — up to and including the repo root; this is the standard Maven/Gradle
 *      module boundary, and a module's src/main/java and src/test/java share it (main↔test stays);
 *   2. else the nearest source-root ancestor: the directory containing src/main/java or
 *      src/test/java (a project with no build file on disk, e.g. an unpacked sample);
 *   3. else the file's own directory (a loose .java file grouped by directory).
 *
 * Cross-module dependencies are real, but they arrive through imports + the module's *declared*
 * dependencies (a later pass) — never by fusing sibling checkouts that merely share a package name.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { IGNORED_DIRS } from "./shared.js";

const MAIN_JAVA = path.join("src", "main", "java");
const TEST_JAVA = path.join("src", "test", "java");
const BUILD_FILES = new Set(["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"]);

export interface JavaLayout {
  repoRoot: string;
  /** absolute dirs that contain a module-marking build file */
  buildFileDirs: Set<string>;
  /** every absolute src/main/java + src/test/java dir, sorted longest-first (innermost wins) */
  sourceRoots: string[];
}

/** Walk the repo once, recording build-file directories and Java source roots. */
export function discoverJavaLayout(repoRoot: string): JavaLayout {
  const root = path.resolve(repoRoot);
  const buildFileDirs = new Set<string>();
  const sourceRoots = new Set<string>();
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isFile() && BUILD_FILES.has(e.name)) buildFileDirs.add(dir);
    }
    for (const e of entries) {
      if (!e.isDirectory() || IGNORED_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (full.endsWith(MAIN_JAVA) || full.endsWith(TEST_JAVA)) sourceRoots.add(full);
      walk(full);
    }
  };
  walk(root);
  return { repoRoot: root, buildFileDirs, sourceRoots: [...sourceRoots].sort((a, b) => b.length - a.length) };
}

export type ModuleKind = "build" | "srcroot" | "dir";
export interface JavaModule {
  /** the module's root directory (absolute) */
  root: string;
  kind: ModuleKind;
}

/** The module `absFile` belongs to (see the file header). */
export function moduleOf(layout: JavaLayout, absFile: string): JavaModule {
  const start = path.dirname(absFile);

  // 1. nearest ancestor (inclusive) with a build file, up to the repo root.
  let dir = start;
  for (;;) {
    if (layout.buildFileDirs.has(dir)) return { root: dir, kind: "build" };
    if (dir === layout.repoRoot) break;
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  // 2. the module that owns the source root containing the file (strip src/main|test/java).
  const srcRoot = layout.sourceRoots.find((r) => absFile === r || absFile.startsWith(r + path.sep));
  if (srcRoot) return { root: path.dirname(path.dirname(path.dirname(srcRoot))), kind: "srcroot" };

  // 3. directory grouping.
  return { root: start, kind: "dir" };
}

/** The source roots that belong to a module (those within its root). */
export function moduleSourceRoots(layout: JavaLayout, moduleRoot: string): string[] {
  return layout.sourceRoots.filter((r) => r === moduleRoot || r.startsWith(moduleRoot + path.sep));
}
