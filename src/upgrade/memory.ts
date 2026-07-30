/**
 * `keel upgrade` Phase 2: memory-informed repair.
 *
 * The failure this exists to prevent: an agent cheerfully "fixing" an upgrade the team already
 * decided against. A version is often pinned for a *reason* — "held back at 4.x, see #812, the 5.x
 * codec breaks our uploads" — and that reason lives in the decision index, mined from the PR thread
 * or written as an ADR. Executing the bump can prove which tests break; it can never surface that
 * the bump itself was already rejected. Only memory can.
 *
 * Two kinds of memory, gathered before anything is proposed:
 *
 *   - **Pins** — recorded decisions that may be about this dependency. Found two ways and unioned:
 *     decisions linked through the graph to the files that import the package, and decisions whose
 *     text is about the package by name. The first catches "we handle uploads this way because…"
 *     attached to the calling code; the second catches "we are staying on lodash 4" attached to
 *     nothing in particular. Both come back with their receipt — the PR or ADR that said it.
 *   - **Past repairs** — when a repair loop reaches green, keel records what made it green. The next
 *     upgrade of the same package gets that patch as context. The second team to hit a breaking
 *     change shouldn't have to rediscover the migration the first team already worked out.
 *
 * Everything here is retrieval and ETL over the event log. No model calls beyond the local query
 * embedding `why` already permits, and that path degrades to keyword matching when Ollama is absent.
 *
 * Keel does NOT decide whether a pin actually forbids the upgrade — the same honesty rule the trust
 * layer follows for decisions generally. It surfaces what was recorded, with the receipt, and says
 * that judging contradiction is the reader's job.
 */
import { answerWhy, type WhyDecision } from "../retrieval/why.js";
import { OllamaEmbeddingModel } from "../retrieval/embed.js";
import { resolveRepoRef, type RepoRef } from "../github/remote.js";
import type { FileGraph } from "../graph/dependencies.js";
import type { KeelEvent } from "../events/store.js";
import type { SqliteEventStore } from "../events/sqlite-store.js";

/** Import sites consulted for file-linked decisions — beyond this the retrieval isn't the bottleneck,
 *  the reader's attention is. */
const MAX_SITES_CONSULTED = 5;
/** Past repairs of one package worth showing; the most recent are the ones that still apply. */
const MAX_PAST_REPAIRS = 3;
/** Recorded repair patches are context, not archives — cap what goes into the log. */
const MAX_RECORDED_PATCH_BYTES = 20_000;

export const PIN_FRAMING =
  "These are RECORDED DECISIONS that may bear on this upgrade — keel does not judge whether they " +
  "forbid it. Read the receipts before proceeding; a pin with a reason is a decision you may be reversing.";

export interface PastRepair {
  /** the version this repair moved to */
  to: string;
  from: string | null;
  occurredAt: string;
  /** the diff that made the upgrade green */
  patch: string;
  /** the tests that PASSED with this patch applied — what the repair is known to have proven. Not
   *  "the tests it fixed": a stateless step never sees the previous attempt, so claiming that would
   *  be inventing history. */
  provenTests: string[];
  /** the import sites it touched */
  importSites: string[];
  /** how many attempts it took, when the recorder knew */
  attempts?: number;
}

export interface UpgradeMemory {
  /** decisions that may bear on this dependency, human-recorded first */
  pins: WhyDecision[];
  /** repairs of this same package keel has recorded before */
  pastRepairs: PastRepair[];
  notes: string[];
}

export const EMPTY_MEMORY: UpgradeMemory = { pins: [], pastRepairs: [], notes: [] };

/**
 * What the team already recorded about this dependency. `graph` enables file linkage; without it
 * only the by-name search runs (and says so).
 */
export async function recallUpgradeMemory(
  repoRoot: string,
  store: SqliteEventStore,
  pkg: string,
  importSites: string[],
  graph: FileGraph | null,
): Promise<UpgradeMemory> {
  const notes: string[] = [];
  const repoRef = await resolveRepoRefQuietly(repoRoot);
  // The same local-only embedding `why` uses: free, private, non-generative, and it falls back to
  // keyword matching when Ollama isn't running (principle 1 — never an error, never a hang).
  const deps = { graph, embedModel: new OllamaEmbeddingModel(), repoRef };

  const byId = new Map<string, WhyDecision>();
  const absorb = (decisions: WhyDecision[]): void => {
    for (const decision of decisions) if (!byId.has(decision.id)) byId.set(decision.id, decision);
  };

  // 1. Decisions attached to the code that imports this package.
  const consulted = importSites.slice(0, MAX_SITES_CONSULTED);
  for (const site of consulted) {
    const result = await answerWhy(store, { path: site }, deps);
    if (!("error" in result)) absorb(result.decisions);
  }
  if (importSites.length > consulted.length) {
    notes.push(`file-linked decisions were looked up for the first ${consulted.length} of ${importSites.length} import sites`);
  }

  // 2. Decisions that are ABOUT the package by name, wherever they're attached — a pin usually is.
  const byName = await answerWhy(store, { question: `${pkg} dependency version upgrade pin` }, deps);
  if (!("error" in byName)) {
    absorb(byName.decisions.filter((d) => mentionsPackage(d, pkg)));
    if (!byName.searched.semantic) {
      notes.push("no local embedding model was reachable, so the by-name search used keyword matching only");
    }
  }

  const pins = [...byId.values()];
  if (pins.length > 0) notes.unshift(PIN_FRAMING);

  const pastRepairs = await recallPastRepairs(store, pkg);
  return { pins, pastRepairs, notes };
}

/**
 * Does this decision actually name the package? The by-name search ranks by similarity and will
 * always return *something*; requiring the package name keeps a vaguely-related decision from being
 * presented as a pin. The same high-precision bar the prompt-context hook holds.
 */
function mentionsPackage(decision: WhyDecision, pkg: string): boolean {
  const haystack = `${decision.summary}\n${decision.rationale}\n${decision.alternatives.join("\n")}`.toLowerCase();
  const needle = pkg.toLowerCase();
  if (haystack.includes(needle)) return true;
  // A scoped package is usually written unscoped in prose: @scope/thing → "thing".
  const unscoped = needle.includes("/") ? needle.slice(needle.lastIndexOf("/") + 1) : null;
  return unscoped !== null && unscoped.length >= 3 && new RegExp(`\\b${escapeRegExp(unscoped)}\\b`).test(haystack);
}

/** Repairs of this package keel recorded on a previous green run, most recent first. */
export async function recallPastRepairs(store: SqliteEventStore, pkg: string): Promise<PastRepair[]> {
  let events: KeelEvent[];
  try {
    events = await store.byKind("upgrade_repair", 200);
  } catch {
    return [];
  }
  const repairs: PastRepair[] = [];
  for (const event of events) {
    const payload = event.payload as Partial<PastRepair> & { package?: unknown };
    if (payload.package !== pkg || typeof payload.patch !== "string") continue;
    repairs.push({
      to: typeof payload.to === "string" ? payload.to : "?",
      from: typeof payload.from === "string" ? payload.from : null,
      occurredAt: event.occurredAt,
      patch: payload.patch,
      provenTests: Array.isArray(payload.provenTests) ? payload.provenTests.filter((t): t is string => typeof t === "string") : [],
      importSites: Array.isArray(payload.importSites) ? payload.importSites.filter((f): f is string => typeof f === "string") : [],
      ...(typeof payload.attempts === "number" ? { attempts: payload.attempts } : {}),
    });
  }
  return repairs.slice(0, MAX_PAST_REPAIRS);
}

export interface RecordRepairInput {
  package: string;
  from: string | null;
  to: string;
  patch: string;
  provenTests: string[];
  importSites: string[];
  attempts: number;
  /** injected for deterministic tests */
  now?: string;
}

/**
 * Record a repair that reached green, so the next upgrade of this package starts from it.
 *
 * Idempotent by (package, version, patch): re-proving the same green step records nothing new, while
 * a genuinely different patch for the same bump is real history and is kept. The event is linked to
 * the import sites it touched, so it also surfaces through ordinary file linkage.
 */
export async function recordRepair(store: SqliteEventStore, input: RecordRepairInput): Promise<string> {
  const patch = input.patch.length > MAX_RECORDED_PATCH_BYTES
    ? `${input.patch.slice(0, MAX_RECORDED_PATCH_BYTES)}\n… (patch truncated by keel at ${MAX_RECORDED_PATCH_BYTES} bytes)`
    : input.patch;
  const externalId = `upgrade:${input.package}@${input.to}:${hash(patch)}`;
  await store.append({
    kind: "upgrade_repair",
    externalId,
    occurredAt: input.now ?? new Date().toISOString(),
    title: `repaired ${input.package} ${input.from ?? "?"} → ${input.to}`,
    payload: {
      package: input.package,
      from: input.from,
      to: input.to,
      patch,
      provenTests: input.provenTests,
      importSites: input.importSites,
      attempts: input.attempts,
    },
    files: input.importSites,
  });
  return externalId;
}

/** djb2 over the patch — an identity for idempotence, not a security digest, so no dependency. */
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The repo's GitHub remote, for decision receipts. Absent (no remote, no network) is fine. */
async function resolveRepoRefQuietly(repoRoot: string): Promise<RepoRef | null> {
  try {
    const ref = await resolveRepoRef(repoRoot);
    return "error" in ref ? null : ref;
  } catch {
    return null;
  }
}
