/**
 * Version-skew detection for a workspace (TS/JS only, for now).
 *
 * The workspace graph is built from the repos as CHECKED OUT — it shows the code sitting on disk in
 * each member. At runtime, a service consumes the *published* version of a dependency (whatever npm
 * resolves its constraint to), which may not be the checkout in the sibling repo. So a cross-repo
 * edge is "the code you'd get if you used this checkout", not a guarantee about production.
 *
 * We surface the gap cheaply: when a member declares a dependency on a package that a sibling member
 * publishes, and the sibling's checked-out `version` doesn't satisfy that constraint, we warn. A
 * deliberately loose, dependency-free version check (honors ^ / ~ / exact; treats ranges and the
 * `workspace:` / `file:` protocols as "intends the checkout", so no false alarm) — enough to say
 * "heads up, the checkout is 2.x but this pins ^1", not a full semver resolver.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkspaceMember } from "./config.js";

const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

interface Manifest {
  member: string;
  name?: string;
  version?: string;
  deps: Record<string, string>;
}

/** Every package.json under a member (excluding node_modules), with its member attribution. */
function readManifests(members: WorkspaceMember[]): Manifest[] {
  const out: Manifest[] = [];
  const walk = (member: string, dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isFile() && e.name === "package.json") {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(dir, e.name), "utf8")) as Record<string, unknown>;
          const deps: Record<string, string> = {};
          for (const field of DEP_FIELDS) {
            const block = data[field];
            if (block && typeof block === "object") {
              for (const [k, v] of Object.entries(block)) if (typeof v === "string") deps[k] = v;
            }
          }
          out.push({
            member,
            ...(typeof data["name"] === "string" ? { name: data["name"] } : {}),
            ...(typeof data["version"] === "string" ? { version: data["version"] } : {}),
            deps,
          });
        } catch {
          /* a malformed manifest contributes nothing */
        }
      } else if (e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".")) {
        walk(member, path.join(dir, e.name));
      }
    }
  };
  for (const m of members) walk(m.name, m.root);
  return out;
}

/** A loose, dependency-free "does `version` satisfy `constraint`?" — honors ^ / ~ / exact; treats
 *  wildcards, comparator ranges, and non-semver protocols as satisfied (so we never false-alarm). */
export function looseSatisfies(version: string, constraint: string): boolean {
  const c = constraint.trim();
  if (c === "" || c === "*" || c === "x" || c === "latest") return true;
  if (/^(?:workspace|file|link|portal|npm|git|github|https?):/i.test(c)) return true; // intends a checkout / alias
  const m = /^([\^~]|>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?/.exec(c);
  if (!m) return true; // unparseable — don't warn
  const op = m[1] ?? "";
  if (op === ">=" || op === "<=" || op === ">" || op === "<") return true; // permissive range — skip
  const [vMaj = "", vMin = "", vPat = ""] = version.split(".");
  const [cMaj, cMin, cPat] = [m[2]!, m[3], m[4]];
  const wild = (part?: string): boolean => part === undefined || part === "x" || part === "X" || part === "*";
  const eq = (v: string, part?: string): boolean => wild(part) || v === part;
  if (op === "^") return cMaj === "0" ? vMaj === cMaj && eq(vMin, cMin) : vMaj === cMaj; // ^0.x pins minor
  if (op === "~") return vMaj === cMaj && eq(vMin, cMin);
  return eq(vMaj, cMaj) && eq(vMin, cMin) && eq(vPat, cPat); // exact
}

/**
 * One warning per (consumer, dependency) where a sibling publishes the dependency but its checked-out
 * version doesn't satisfy the declared constraint. Empty when everything lines up (or there are no
 * cross-repo TS dependencies to check).
 */
export function versionSkewWarnings(members: WorkspaceMember[]): string[] {
  const manifests = readManifests(members);
  const published = new Map<string, { member: string; version: string }>();
  for (const m of manifests) {
    if (m.name && m.version && !published.has(m.name)) published.set(m.name, { member: m.member, version: m.version });
  }

  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const m of manifests) {
    for (const [dep, constraint] of Object.entries(m.deps)) {
      const pub = published.get(dep);
      if (!pub || pub.member === m.member) continue; // not a sibling's package
      if (looseSatisfies(pub.version, constraint)) continue;
      const key = `${m.member}|${dep}|${constraint}|${pub.version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      warnings.push(
        `version skew: ${m.member} depends on ${dep}@${constraint}, but the ${pub.member} checkout is ${pub.version} — ` +
          `the workspace graph reflects the checkout, not the version resolved at runtime`,
      );
    }
  }
  return warnings.sort();
}
