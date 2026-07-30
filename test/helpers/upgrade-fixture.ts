/**
 * The `keel upgrade` fixture repo, built fresh per test.
 *
 * The vendored package versions live OUTSIDE the git repo, and package.json points at them by
 * absolute `file:` path. That detail is load-bearing, not incidental: a `file:` (or workspace)
 * dependency whose target sits *inside* the repo installs as a symlink to in-repo source, and keel's
 * graph then — correctly — resolves imports of it to those real files rather than retaining an
 * external specifier. The package would have zero "import sites" and the fixture would be testing a
 * shape no registry dependency ever has. Keeping the versions outside makes `greeter` behave exactly
 * like a published package while still needing no network.
 *
 * (`scopeUpgrade` detects and explains the in-repo-link case; `upgrade.test.ts` covers it directly.)
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { npmCapture } from "./platform.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "upgrade");

export interface UpgradeFixture {
  /** the git repo keel analyses */
  dir: string;
  /** where the vendored versions live, outside the repo */
  registry: string;
  /** an upgrade target string for one of the vendored versions (defaults to the greeter package) */
  target(version: string, pkg?: string): string;
  /** the parent to delete when done */
  root: string;
}

function git(dir: string, args: string[]): void {
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

/**
 * Build the fixture. `install` runs a real (offline) `npm install` in the repo, which is what puts
 * the CURRENT version on disk — without it there is no "before" side for the package's own diff.
 */
export function makeUpgradeRepo(options: { install?: boolean } = {}): UpgradeFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keel-upgrade-"));
  const dir = path.join(root, "repo");
  const registry = path.join(root, "registry");

  fs.cpSync(FIXTURE, dir, { recursive: true });
  fs.renameSync(path.join(dir, "vendor"), registry);

  // Repoint every dependency at the out-of-repo copy, by absolute path.
  const manifestPath = path.join(dir, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { dependencies: Record<string, string> };
  for (const [name, spec] of Object.entries(manifest.dependencies)) {
    manifest.dependencies[name] = spec.replace(/^file:vendor\//, `file:${registry}${path.sep}`);
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n.keel/\npackage-lock.json\n");

  git(dir, ["init", "-b", "main"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "fixture"]);

  if (options.install) {
    // Offline: every dependency is a local path, so this needs no registry — and must not reach for
    // one. Ambient npm config, not a keel setting.
    const previous = process.env["npm_config_offline"];
    process.env["npm_config_offline"] = "true";
    try {
      npmCapture(["install", "--no-audit", "--no-fund"], { cwd: dir });
    } finally {
      if (previous === undefined) delete process.env["npm_config_offline"];
      else process.env["npm_config_offline"] = previous;
    }
  }

  return {
    dir,
    registry,
    root,
    target: (version: string, pkg = "greeter") => `${pkg}@file:${path.join(registry, `${pkg}-${version}`)}`,
  };
}

/** Run `op` with npm pinned offline, so a fixture install can never reach the registry. */
export function offline<T>(op: () => Promise<T>): Promise<T> {
  const previous = process.env["npm_config_offline"];
  process.env["npm_config_offline"] = "true";
  return op().finally(() => {
    if (previous === undefined) delete process.env["npm_config_offline"];
    else process.env["npm_config_offline"] = previous;
  });
}
