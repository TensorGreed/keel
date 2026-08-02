/**
 * A PR proposal per upgrade: branch, title, body, and the manifest patch — each carrying its own
 * executed proof.
 *
 * **Keel composes these; it does not open them.** Opening a PR means pushing a branch to a remote
 * under someone's credentials — outward-facing, hard to undo, and dependent on which remote, which
 * base, and whether force is acceptable. None of that is keel's to assume, and getting it wrong is
 * the kind of mistake a tool doesn't get to make twice. So the output is everything needed to open
 * the PR plus the exact commands to do it, and a human (or an agent with the authority) runs them.
 * `keel verdict --github-check` remains the supported way keel writes to GitHub, because publishing
 * a check on a PR that already exists is additive and reversible.
 *
 * The body is the point. A dependency-bump PR normally arrives with no evidence at all — a version
 * number and a hope. This one carries what was executed: the blast radius, which tests ran and what
 * they did, the install-time signals, the part of the surface no test covers, any recorded decision
 * that bears on the bump, and the verdict. A reviewer can approve or reject it without re-deriving
 * anything.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { BatchOutcome } from "./batch.js";
import type { UpgradeReport } from "./upgrade.js";

export interface PrProposal {
  /** the branch to create, derived from package and version */
  branch: string;
  title: string;
  /** markdown, carrying the executed proof */
  body: string;
  /** the manifest change, as a unified diff against HEAD */
  patch: string;
  /** copy-pasteable commands that would actually open it — keel runs none of them */
  commands: string[];
  /** true only when policy classified this auto-merge; a label for the opener, not an instruction */
  autoMergeable: boolean;
}

/** git refs disallow a lot; reduce anything unusual to a dash rather than emitting an invalid ref. */
function branchSafe(text: string): string {
  return text
    .replace(/^@/, "")
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/\.{2,}|^[-.]+|[-.]+$/g, "")
    .slice(0, 60) || "package";
}

/**
 * A unified diff that rewrites just this dependency's line in package.json.
 *
 * Built against the REAL file, not a guessed one: the exact line is located in the repo's current
 * package.json and the hunk is emitted with proper line numbers and context, so `git apply` accepts
 * it. A hand-shaped diff with a decorative hunk header would look right in a report and fail the
 * moment anyone tried to use it — which is worse than offering no patch at all. When the line can't
 * be located, that's exactly what we do: offer none, and say so.
 *
 * The line is matched on the JSON-*encoded* name and spec, not the decoded values. `report.from`
 * comes back from `JSON.parse`, so a spec containing anything JSON escapes — most obviously a
 * Windows path, `file:C:\\repo\\dep`, which is stored as `file:C:\\\\repo\\\\dep` — would never be
 * found by a raw text search, and the upgrade would silently offer no patch. Encoding both sides is
 * what makes the search correct for any specifier on any platform.
 */
export function manifestPatch(repoRoot: string, report: UpgradeReport): string {
  if (report.from === null) return ""; // undeclared: there is no line to rewrite
  const to = report.installedVersion ? `^${report.installedVersion}` : report.requested;

  let lines: string[];
  let endsWithNewline: boolean;
  try {
    const raw = fs.readFileSync(path.join(repoRoot, "package.json"), "utf8");
    lines = raw.split("\n");
    // Splitting a file that ends with a newline leaves a phantom empty element. Counting it as a
    // context line inflates the hunk header and `git apply` rejects the whole patch — so drop it and
    // remember, since a file WITHOUT a trailing newline needs the marker git expects instead.
    endsWithNewline = lines[lines.length - 1] === "";
    if (endsWithNewline) lines.pop();
  } catch {
    return "";
  }

  // The declaration line: `"pkg": "<current spec>"`, matched on both name and spec so a package
  // listed in two sections can't be confused for the one that was actually bumped. Both sides are
  // JSON-encoded first — see the note above about escapes.
  const key = JSON.stringify(report.package);
  const fromEncoded = JSON.stringify(report.from);
  const needle = new RegExp(`^(\\s*)${escapeRegExp(key)}\\s*:\\s*${escapeRegExp(fromEncoded)}(,?)\\s*$`);
  const index = lines.findIndex((l) => needle.test(l));
  if (index < 0) return "";

  const match = needle.exec(lines[index]!)!;
  const replacement = `${match[1]}${key}: ${JSON.stringify(to)}${match[2]}`;

  // A 3-line context window, clamped to the file, with 1-based line numbers as unified diff wants.
  const start = Math.max(0, index - 3);
  const end = Math.min(lines.length, index + 4);
  const before = lines.slice(start, index);
  const after = lines.slice(index + 1, end);
  const count = before.length + 1 + after.length;

  const body = [...before.map((l) => ` ${l}`), `-${lines[index]!}`, `+${replacement}`, ...after.map((l) => ` ${l}`)];
  // A file with no trailing newline must say so, or git applies a patch that adds one.
  if (!endsWithNewline && end === lines.length) body.push("\\ No newline at end of file");

  return [
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    `@@ -${start + 1},${count} +${start + 1},${count} @@`,
    ...body,
    "",
  ].join("\n");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function bullet(lines: string[]): string {
  return lines.map((l) => `- ${l}`).join("\n");
}

/** Compose the proposal. Returns undefined when there is nothing to propose. */
export function buildPrProposal(repoRoot: string, report: UpgradeReport, outcome: BatchOutcome): PrProposal | undefined {
  if (outcome === "pinned" || outcome === "not-run") return undefined;

  const version = report.installedVersion ?? report.requested;
  const branch = `keel/upgrade/${branchSafe(report.package)}-${branchSafe(version)}`;
  const title = `chore(deps): upgrade ${report.package} to ${version}`;

  const s = report.scope;
  const e = report.executed;
  const sections: string[] = [];

  sections.push(
    `Upgrades \`${report.package}\` from \`${report.from ?? "(undeclared)"}\` to \`${version}\`.`,
    "",
    "### What keel executed",
    "",
    bullet([
      `**Blast radius:** ${s.surface.length} file(s), ${(s.shareOfRepo * 100).toFixed(1)}% of the repo, from ${s.importSites.length} import site(s)`,
      `**Tests run:** ${e.status}${e.runner ? ` via ${e.runner}` : ""} — ${e.passed ?? 0} passed, ${e.failures.length} failed`,
      `**Install:** ${report.install.ok ? "completed cleanly" : "FAILED"}${report.install.signals.length > 0 ? ` — ${report.install.signals.length} signal(s)` : ""}`,
    ]),
  );

  if (e.failures.length > 0) {
    sections.push("", "### Failing tests", "", bullet(e.failures.map((f) => `\`${f.test}\`${f.file ? ` (${f.file})` : ""} — ${f.message}${f.importSite ? ` · import site: \`${f.importSite}\`` : ""}`)));
  }
  if (report.install.signals.length > 0) {
    sections.push("", "### Install signals", "", bullet(report.install.signals.map((sig) => `**${sig.kind}** — ${sig.message}`)));
  }
  if (e.discountedFlaky.length > 0) {
    sections.push(
      "",
      "### Discounted as flaky",
      "",
      "These failed, but CI has seen them pass *and* fail on one commit, so keel discounted them. Shown so you can disagree:",
      "",
      bullet(e.discountedFlaky.map((f) => `\`${f.test}\`${f.file ? ` (${f.file})` : ""} — ${f.message}`)),
    );
  }
  if (s.uncoveredSurface.length > 0) {
    sections.push(
      "",
      "### Not proven by this run",
      "",
      `${s.uncoveredSurface.length} file(s) in the upgrade surface are reached by no test, so a green run does **not** clear them:`,
      "",
      bullet(s.uncoveredSurface.slice(0, 10).map((f) => `\`${f}\``)),
    );
  }
  if (report.memory.pins.length > 0) {
    sections.push(
      "",
      "### Recorded decisions that may bear on this",
      "",
      "Keel surfaces these; it does not judge whether they forbid the upgrade.",
      "",
      bullet(
        report.memory.pins.map(
          (p) => `[${p.origin}] ${p.summary} — ${p.source.url ?? p.source.adrPath ?? (p.source.pr !== null ? `PR #${p.source.pr}` : p.id)}`,
        ),
      ),
    );
  }

  sections.push(
    "",
    "### Verdict",
    "",
    `**${report.verdict.verdict.toUpperCase()}** — ${outcome}`,
    "",
    bullet(report.verdict.reasons.map((r) => `\`${r.rule}\` ${r.outcome}: ${r.detail}`)),
    "",
    "---",
    "",
    "Generated by `keel upgrade --batch`. The results above were **executed** in an isolated worktree, not predicted.",
  );

  // Commands keel does NOT run. Each one is real and in order; the body is written to a file first
  // because it is markdown with newlines and quoting it inline is a footgun.
  const patch = manifestPatch(repoRoot, report);
  const bodyFile = `/tmp/${branchSafe(report.package)}-pr-body.md`;
  const commands = patch
    ? [
        `git switch -c ${branch}`,
        `git apply <<'KEEL_PATCH'\n${patch}KEEL_PATCH`,
        "npm install   # refresh the lockfile",
        `git commit -am ${JSON.stringify(title)}`,
        `git push -u origin ${branch}`,
        `# write the body (it is .entries[].pr.body in \`keel upgrade --batch --json\`), then:`,
        `gh pr create --title ${JSON.stringify(title)} --body-file ${bodyFile}`,
      ]
    : [`# ${report.package} is not declared in package.json, so keel has no manifest line to rewrite — add it first`];

  return { branch, title, body: sections.join("\n"), patch, commands, autoMergeable: outcome === "auto-merge" };
}
