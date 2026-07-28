/**
 * keel.policy.json: the versioned, hand-validated policy the verdict is evaluated against.
 * Pure — no I/O beyond reading the file, no model calls. A missing file yields conservative
 * defaults (flagged as "default"); a malformed file is an error, never a silent fallback.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const POLICY_VERSION = 1;
const POLICY_FILE = "keel.policy.json";

export interface ProtectedPath {
  glob: string;
  reason: string;
}

/** An architectural rule: files matching `from` must not import files matching `to`. */
export interface ForbiddenImport {
  from: string;
  to: string;
  reason: string;
}

export interface Policy {
  version: number;
  /** block when the file-level blast radius exceeds this; null = no cap */
  maxBlastRadius: number | null;
  /** block when tests fail in the sandbox */
  requireSimPass: boolean;
  /** block when a changed source file has no covering test */
  forbidUncoveredChanges: boolean;
  /** block when the sim ran only a capped subset of the selected tests */
  forbidTruncatedSim: boolean;
  /** block when the diff touches a path matching one of these globs */
  protectedPaths: ProtectedPath[];
  /** block when a changed file introduces or retains a from→to import edge */
  forbiddenImports: ForbiddenImport[];
  /** warn when the change may be affected by recorded decisions (relevantDecisions non-empty) */
  requireDecisionReview: boolean;
}

/** Conservative defaults for a repo with no policy file: prove the change is safe to run,
 *  but don't gate on blast radius / coverage / decisions until a policy opts in. */
export const DEFAULT_POLICY: Policy = {
  version: POLICY_VERSION,
  maxBlastRadius: null,
  requireSimPass: true,
  forbidUncoveredChanges: false,
  forbidTruncatedSim: false,
  protectedPaths: [],
  forbiddenImports: [],
  requireDecisionReview: false,
};

export interface LoadedPolicy {
  policy: Policy;
  source: "default" | "file";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate a parsed policy object into a Policy, or return a precise error string. */
export function parsePolicy(data: unknown): Policy | { error: string } {
  if (!isObject(data)) return { error: "policy must be a JSON object" };
  if (data["version"] !== POLICY_VERSION) {
    return { error: `unsupported policy version ${JSON.stringify(data["version"])} (expected ${POLICY_VERSION})` };
  }

  const bool = (key: string, dflt: boolean): boolean | { error: string } => {
    const v = data[key];
    if (v === undefined) return dflt;
    if (typeof v !== "boolean") return { error: `"${key}" must be a boolean` };
    return v;
  };

  const requireSimPass = bool("requireSimPass", DEFAULT_POLICY.requireSimPass);
  if (typeof requireSimPass === "object") return requireSimPass;
  const forbidUncoveredChanges = bool("forbidUncoveredChanges", DEFAULT_POLICY.forbidUncoveredChanges);
  if (typeof forbidUncoveredChanges === "object") return forbidUncoveredChanges;
  const forbidTruncatedSim = bool("forbidTruncatedSim", DEFAULT_POLICY.forbidTruncatedSim);
  if (typeof forbidTruncatedSim === "object") return forbidTruncatedSim;
  const requireDecisionReview = bool("requireDecisionReview", DEFAULT_POLICY.requireDecisionReview);
  if (typeof requireDecisionReview === "object") return requireDecisionReview;

  let maxBlastRadius: number | null = DEFAULT_POLICY.maxBlastRadius;
  if (data["maxBlastRadius"] !== undefined && data["maxBlastRadius"] !== null) {
    const n = data["maxBlastRadius"];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
      return { error: '"maxBlastRadius" must be a non-negative number or null' };
    }
    maxBlastRadius = n;
  } else if (data["maxBlastRadius"] === null) {
    maxBlastRadius = null;
  }

  const protectedPaths: ProtectedPath[] = [];
  if (data["protectedPaths"] !== undefined) {
    if (!Array.isArray(data["protectedPaths"])) return { error: '"protectedPaths" must be an array' };
    for (const entry of data["protectedPaths"]) {
      if (!isObject(entry) || typeof entry["glob"] !== "string" || typeof entry["reason"] !== "string") {
        return { error: '"protectedPaths" entries must be { glob: string, reason: string }' };
      }
      protectedPaths.push({ glob: entry["glob"], reason: entry["reason"] });
    }
  }

  const forbiddenImports: ForbiddenImport[] = [];
  if (data["forbiddenImports"] !== undefined) {
    if (!Array.isArray(data["forbiddenImports"])) return { error: '"forbiddenImports" must be an array' };
    for (const entry of data["forbiddenImports"]) {
      if (!isObject(entry) || typeof entry["from"] !== "string" || typeof entry["to"] !== "string" || typeof entry["reason"] !== "string") {
        return { error: '"forbiddenImports" entries must be { from: string, to: string, reason: string }' };
      }
      if (entry["from"] === "" || entry["to"] === "") {
        return { error: '"forbiddenImports" from/to globs must be non-empty' };
      }
      forbiddenImports.push({ from: entry["from"], to: entry["to"], reason: entry["reason"] });
    }
  }

  return { version: POLICY_VERSION, maxBlastRadius, requireSimPass, forbidUncoveredChanges, forbidTruncatedSim, protectedPaths, forbiddenImports, requireDecisionReview };
}

/** Load keel.policy.json from the repo root. Missing -> defaults; malformed -> { error }. */
export function loadPolicy(repoRoot: string): LoadedPolicy | { error: string } {
  const file = path.join(repoRoot, POLICY_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { policy: DEFAULT_POLICY, source: "default" };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { error: `${POLICY_FILE} is not valid JSON: ${(err as Error).message}` };
  }
  const parsed = parsePolicy(data);
  if ("error" in parsed) return { error: `${POLICY_FILE}: ${parsed.error}` };
  return { policy: parsed, source: "file" };
}

/**
 * Match a repo-relative posix path against a glob. `*` matches within a path segment (not
 * "/"); `**` matches across segments. Segment-based, like the graph's workspace matcher,
 * extended for string matching — no new deps.
 */
export function globMatch(glob: string, filePath: string): boolean {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?"; // `**/` — zero or more leading segments
        } else {
          re += ".*"; // `**` — anything, including "/"
        }
      } else {
        re += "[^/]*"; // `*` — within one segment
      }
    } else if (".+?^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(re + "$").test(filePath);
}
