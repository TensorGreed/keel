# CLAUDE.md — Build guide for Keel

Keel is a development intelligence layer delivered as an **MCP server**. It gives coding
agents (and humans) three capabilities over a codebase: **team memory** (why is it like
this?), **flight simulation** (what actually happens if I change it?), and a **trust
layer** (is this change safe to automate?). Read `docs/concept.md` for the full vision,
`docs/architecture.md` for the substrate design, and `docs/roadmap.md` for the phase you
are currently building.

## Non-negotiable design principles

1. **No flagship-model calls on the server side. Ever.** Keel returns compact, structured
   facts; the expensive reasoning happens in the caller's own agent session (Claude Code,
   Copilot, Cursor). If a feature seems to need deep server-side reasoning, redesign it to
   hand context to the caller instead. Cheap/local models (Ollama, batch Haiku-class) are
   permitted in offline ingestion pipelines (decision mining, embeddings). One narrow
   exception at query time in the MCP server: a **local** embedding model (Ollama) may be
   called to embed a query for semantic retrieval — it is free, private, and non-generative.
   Remote or generative model calls remain forbidden server-side, and every query path that
   uses a local model must degrade gracefully (a fallback, never an error or a hang) when no
   local model is reachable.
2. **Deterministic core.** The system graph, event log, and simulator are static analysis,
   ETL, and sandboxed execution — never LLM guesses. An answer from Keel must be
   reproducible and, where it claims something breaks, backed by an executed test.
3. **Repo-only value first.** Every feature must produce value with nothing but a git
   repo connected. Jira/CI/deploy connectors are progressive enrichment, never
   prerequisites.
4. **Proof over prediction.** Prefer "here are the 3 executed test failures" to "this
   might affect 14 files". If we can't execute, we say so explicitly in the tool output.

## Current target

- **Language under analysis:** TypeScript/JavaScript (the dominant full-stack set).
  The graph builder starts with the TS compiler API; migrate hot paths to tree-sitter
  when we add more languages.
- **Runtime:** Node >= 22.13 (node:sqlite is unflagged there; no --experimental-sqlite),
  ESM only, TypeScript strict.
- **Protocol:** MCP over stdio via `@modelcontextprotocol/sdk`.

## Commands

```bash
npm install        # setup
npm run build      # tsc -> dist/
npm test           # vitest run
npm run dev        # run the MCP server (stdio) against a target repo
```

The server takes the target repo path from the `KEEL_REPO` env var (defaults to cwd).

## Code map

```
src/
  index.ts          CLI entry: dispatches serve (default), init, ingest, mine, decision,
                    verdict, report, prompt-context, doctor, upgrade
  serve.ts          Starts the MCP server over stdio; ingests commits first
  doctor/           `keel doctor`: doctor.ts (pure checks over a gathered DoctorEnv → ok/warn/fail
                    with one named fix each), cli.ts (defensive real-env probes; table + --json,
                    exit 1 on red). Bounded probes via util/timeouts (2s GitHub/Ollama leash); one
                    probe scales with the repo — a timed COLD graph build (files/edges/ms-per-file,
                    warns past 1 ms/file above 500 files), skippable with --no-graph
  util/             timeouts.ts (central timeout policy + fetchTimed/execFileTimed/withProgress for
                    every outbound call; audited by test/timeout-audit.test.ts), sanitize.ts
                    (neutralize+cap attacker-influenced decision text before it reaches an agent),
                    and platform.ts (every Windows-vs-POSIX difference in one place: PATHEXT-aware
                    resolveOnPath, spawnSpec for .cmd/.bat shims, linkDir/unlinkDir junctions,
                    localPackageBin, canonicalPath — pure logic, so outside the timeout audit)
  init.ts           `keel init`: register keel in a project's .mcp.json + add a "Working with
                    Keel" guidance section to the repo's CLAUDE.md (idempotent markers; --no-claude-md)
                    + install the prompt-context UserPromptSubmit hook in .claude/settings.json
                    (non-destructive merge, idempotent; --no-hooks)
  mcp/tools.ts      Tool definitions + zod schemas (get_dependencies, get_impact,
                    select_tests, preflight, why, verdict, context, suggest_reviewers,
                    get_history, flaky_tests; workspace_impact when in a workspace)
  graph/            System graph, language-agnostic composer + a per-language scanner seam:
                    scanner.ts (LanguageScanner interface), typescript-scanner.ts (TS compiler
                    API), python-scanner.ts (web-tree-sitter WASM, grammar in graph/wasm/),
                    scanners.ts (registry by extension + async init), dependencies.ts (walk +
                    resolve + assemble), cache.ts (incremental, git-HEAD-keyed graph cache),
                    spring.ts (Java DI edges), go-scanner.ts / java-scanner.ts (WASM scanners),
                    java-modules.ts (Java module scoping for adjacency + resolution + DI)
  workspace/        Cross-repo graph: config.ts (keel.workspace.json), graph.ts (merge member
                    graphs, namespace as name::path, add cross-repo edges), cli.ts (`keel
                    workspace`). Graph/impact layer only — execution/decisions/tools stay single-repo
  upgrade/          `keel upgrade`. Phase 0 (REPORT-ONLY): scope.ts (import sites from the graph's
                    retained externalImports -> union blast radius + covering tests + uncovered
                    surface; notes a package LINKED to in-repo source, whose zero would otherwise
                    read as "unused"), install.ts (rewrite package.json in the worktree, `npm
                    install` — the ONE place install runs — and read peer/engine/failure signals out
                    of npm's own output, warnings included), execute.ts (the one sandboxed bump both
                    phases share: patch -> bump+install -> tests -> flaky discounting), upgrade.ts
                    (-> next steps -> verdict via evaluatePolicy), report.ts, cli.ts.
                    Phase 1 (repair loop): repair.ts (INVERTED and STATELESS — keel can't write the
                    fix, so each call proves the caller's accumulated patch and hands back ONE task
                    or green/exhausted/blocked; tests run = upgrade surface + whatever the patch
                    touched) and evidence.ts (symbols in play via a single-file re-scan, CHANGELOG
                    sliced between the versions, `git diff --no-index` of the package's own manifest
                    and entry — and a note for whatever it could NOT establish).
                    MCP: `upgrade_scope`, `upgrade_repair`
  simulate/         Flight simulator: impact.ts (diff -> impacted subgraph),
                    select-tests.ts (impacted -> covering test files),
                    sandbox.ts (apply diff in a temp worktree, run the tests; `prepare` hook +
                    linkNodeModules:false are the seam `keel upgrade` installs through, and node:test
                    now reports via its junit reporter so zero-dep repos get structured failures),
                    preflight.ts (impact -> select -> sandbox, budgeted)
  github/           `keel ingest` (GitHub half): backfill PRs + review threads into the event log
                    (remote.ts, client.ts over global fetch, ingest.ts ETL — no deps); cli.ts also
                    drives the local ADR source; check.ts publishes a verdict as a GitHub check run
  adr/              `keel ingest` (local half): parse.ts (MADR: title/status/context/decision) +
                    ingest.ts (docs/adr, docs/decisions → origin "adr" decision events, linked to
                    graph nodes, idempotent by path+hash). No model calls; embedding is best-effort.
  ci/               `keel ci`: ingest JUnit test reports into ci_run events (junit.ts parser,
                    ingest.ts ETL, cli.ts — no deps). Feeds flaky-test detection. No model calls.
  mining/           `keel mine`: extract decision records from PR threads (OFFLINE only).
                    The one place model calls are allowed — Ollama (local, default), Anthropic
                    (Haiku), or any OpenAI-compatible endpoint (KEEL_OPENAI_BASE_URL → DeepSeek/
                    Groq/vLLM/…); injectable DecisionModel; never reached from the MCP server.
                    Cloud runs > 25 PRs print a cost estimate first; local stays the default.
  retrieval/        Decision index: embed.ts (local embeddings, injectable),
                    index.ts (retrieve by graph node or meaning), why.ts (the `why` tool's
                    composition — file links + semantic/keyword, human overrides, receipts),
                    prompt-context.ts + prompt-context-cli.ts (`keel prompt-context`: a Claude Code
                    UserPromptSubmit hook that fast-matches the prompt to decisions and injects the
                    top 3 as additionalContext — budgeted, silent on no hits, never errors/blocks)
  context/          briefing.ts: the `context` tool — resolve a task's candidate files, then
                    compose blast radius + history + decisions + tests + owners + policy risks
                    (ranked, capped, keyword-fallback like why). No generative calls.
  ownership/        ownership.ts: recency-weighted authorship per file from the event log
                    (commit + PR authors, bots excluded) → `suggest_reviewers`, context owners,
                    and the verdict's warnOnForeignCode signal. No model calls.
  trust/            Trust layer: facts.ts (compose impact/preflight/decisions into
                    machine-checkable facts), policy.ts (keel.policy.json, pure eval +
                    glob), arch.ts (forbiddenImports: forbidden from→to graph edges),
                    hotspots.ts (rank files by churn × blast radius × coverage gap),
                    verdict.ts (pass/warn/block with audited reasons), verdict-cli.ts
                    (`keel verdict` for CI + hooks), report-cli.ts (`keel report`
                    --arch / --hotspots, repo-wide reports for adoption + triage).
                    No model calls.
  git/              Git history + commit listing (child_process, no deps)
  events/           Event log: schema.sql + EventStore (SqliteEventStore via node:sqlite)
recipes/            Copy-pasteable integrations (claude-code-hook.md: verdict as a Stop hook;
                    github-check.md: verdict as a GitHub check on every PR)
test/               Vitest; fixtures under test/fixtures/, cross-platform helpers under
                    test/helpers/ (always use rmDir, not fs.rmSync, in afterEach)
test/ci/            Opt-in batteries, EXCLUDED from `npm test` (vitest.config.ts) because they take
                    minutes: coldstart.test.ts (graph invariants over pinned SHAs of hono/flask/gin/
                    spring-petclinic — drift insurance, weekly via .github/workflows/coldstart.yml,
                    which files an issue on failure) and perf.test.ts (the large-repo budget over a
                    generated ~24k-file four-language repo; synth-repo.ts is the generator; budgets
                    documented in docs/architecture.md). `npm run test:coldstart` / `test:perf`
```

## Conventions

- ESM imports with `.js` extensions in source (NodeNext resolution).
- Every MCP tool: zod input schema, structured JSON output, graceful errors as
  `{ error: string }` — never throw across the protocol boundary.
- No native-module dependencies unless unavoidable (keeps install friction near zero).
- Tests colocated under `test/`, named `*.test.ts`. New tool = new test.
- Commits: imperative subject, body explains *why*. Update `docs/roadmap.md` checkboxes
  in the same commit as the feature.

## Release checklist

- **Every user-visible change updates `CHANGELOG.md` in the same commit.** User-visible means
  anything a consumer can observe: a new or changed MCP tool or CLI command, a policy /
  workspace schema field, an env var, an output shape, an exit code, a graph-cache format
  bump, a behavioural change in what gates or warns. Pure internals (a refactor, a test, a
  doc typo) do not. Keep-a-changelog format; add to the topmost unreleased version section,
  under Added / Changed / Fixed / Security.
- Cutting a release: rename the unreleased heading to `## [x.y.z] — YYYY-MM-DD`, bump
  `package.json` `version` to match, update the compare links at the bottom of the changelog,
  then push a `v x.y.z` tag (no space) — `release.yml` publishes to npm via OIDC trusted
  publishing on the tag.
- Pre-1.0, a breaking change goes under **Changed** with a migration note, and bumps the
  minor version.

## Where we are

Phase 0 (substrate skeleton) is complete. `get_dependencies` walks import edges via the
TS compiler API (with tsconfig path aliases, workspace resolution, and symbol-level
usage), served from an incremental graph cache keyed by git HEAD (`graph/cache.ts`);
`get_history` shells out to git log. The event log persists to SQLite (`SqliteEventStore`,
node:sqlite) and ingests commits on startup. `keel init` registers the server in
`.mcp.json`. Every edge in a dependency report carries its **provenance** (`edges`/
`dependentEdges`, each `{ file, kind }`): `import` (a real directed import), `package`
(Java/Go same-package unit adjacency — inherently mutual, symbol `*` both ways, so a mutual
`*` edge reads as the model, not an analyzer bug), or `di` (Spring wiring). `EdgeKind` in
`scanner.ts`; only non-default kinds are stored (graph format v5); `import` > `di` > `package`
when an edge has two provenances.

Phase 1 (flight simulator) is complete. `get_impact` maps a diff to its impacted subgraph
(symbol-narrowed, with an intra-file reference closure), `select_tests` picks the covering
tests, and `preflight` ties it together: it validates the diff with `git apply`, applies it
in an isolated worktree (`sandbox.ts`), and runs the selected tests under hard budget caps,
returning executed pass/fail with per-failure traces and the import path from each failing
test back to the change. Explicit diffs are validated the same way analysis and execution
apply them, so the two never disagree.

Phase 2 (team memory) is complete. `keel ingest` backfills GitHub PRs + review threads into
the event log; `keel mine` extracts decision records from them with a local (Ollama) or
batch-Haiku model and embeds them locally for retrieval — incrementally: it tracks which PRs
it has mined (any outcome) so a re-run only touches new or changed PRs and never re-charges
the model for a no-decision PR. Backfill is observable and un-hangable: it prints the auth
mode + target on start (`ingesting owner/repo as <user>` — validates the token too), a
progress line per PR page (and every N PRs within a page) to stderr, and every request has a
30s timeout (`KEEL_HTTP_TIMEOUT`, seconds) — a stalled proxy surfaces as the same clean
"resume by re-running" stop as a rate limit (`GitHubError.timedOut`), never a silent hang. Model calls happen only here (offline) plus a local query
embedding in the server. The `why` MCP tool answers "why is this like this?" for a file or
question, linking decisions through the graph with PR source receipts; `keel decision
add`/`reject` gives humans an override that outranks or suppresses mined records.

ADR ingestion (the last Phase 5 item) makes `keel ingest` dual-source: the GitHub half above, plus
a **local** half (`src/adr/`) that ingests Markdown ADRs under docs/adr/ and docs/decisions/ — no
network, repo-only value. They're MADR-parsed (title/status/context/decision) into decision events
with origin **"adr"**, ranked above mined records but below an explicit `keel decision add` (an ADR
is human-authored but not a keel-specific override); linked to graph nodes by repo-relative paths in
the body (unlinked ADRs still surface via question search); idempotent by path + content hash, with
edits re-ingesting (a new `deleteEvent` on the store replaces the stale event). No model calls in
ingestion — embedding stays the offline best-effort path, like every other decision. Receipts are
the ADR file path + title.

Phase 3 (trust layer) is complete. The `verdict` MCP tool composes the earlier facts —
blast radius, the executed preflight sim, uncovered changes, and decisions the change may
affect — and evaluates them against `keel.policy.json` (conservative defaults if absent) to
return a machine-checkable pass | warn | block, each reason naming the exact rule and fact
that triggered it. The same computation is reachable from the shell as `keel verdict`
(`trust/verdict-cli.ts`): exit codes 0/2/1 for CI gating, `--json` for the full verdict,
`--hook` (the Claude Code Stop-hook protocol — reads the event on stdin, emits block JSON on a
failing verdict, honors `stop_hook_active`; see `recipes/claude-code-hook.md`), and
`--github-check`, which publishes the verdict as a GitHub check run on the PR head via
`github/check.ts` (base-checkout + forward-diff recipe in `recipes/github-check.md`). Pure
evaluation, no model calls (`src/trust/`); the check is ETL plumbing (a REST POST), also no
model calls.

Phase 4 (compose) is underway. The `context` MCP tool (`src/context/briefing.ts`) is the first
item: one call takes a free-text task (plus any files the caller already knows) and returns a
briefing — the candidate files ranked by relevance, each with blast radius + key dependents,
recent history, linked decisions with receipts, and covering tests; rolled up into
suggestedTests, relevantDecisions (human-first), and risks (uncovered / high-blast-radius /
protected-path, the last two read from keel.policy.json). Pure composition of the existing
engines; ranking uses the same local query embedding as `why` with the identical keyword
fallback, and every truncation is stated in `notes`. No generative calls.

The second Phase 4 item, architectural import rules, is also done. `keel.policy.json` gains
`forbiddenImports: [{ from, to, reason }]` — a change that introduces or retains a graph edge
from a `from`-glob file to a `to`-glob file blocks, the verdict naming the exact importer →
imported edge and the reason (`src/trust/arch.ts`, evaluated against the post-change working-
tree graph, scoped to changed files). `keel report --arch` lists every repo-wide violation
(informational, exit 0) so a team can adopt a rule on a legacy repo before it gates anyone —
changed-file edges gate, pre-existing edges inform. Keel dogfoods one rule itself: the MCP
server may not import the offline mining layer (principle 1). Pure graph analysis, no model calls.

Phase 4 item 3, risk hotspots, is done. `keel report --hotspots` ranks files by
risk = churn × (blast radius + 1) × coverage gap — churn from the event log (commits touching
the file in a trailing window, default 90d/`--days`), blast radius from the cached graph,
coverage from the select_tests machinery (`src/trust/hotspots.ts`, `churnByFile` on the store).
Every line shows the components, not just the score; capped by `--limit` (default 20). `keel
report` with no flag prints arch + hotspots. The `context` tool flags a candidate that ranks as
a top hotspot. No model calls.

Phase 4 item 4, the ownership/reviewer signal, is done (`src/ownership/ownership.ts`). Authorship
is the recency-weighted share of commit + PR authorship per file from the event log (half-life
180 days; bots like dependabot excluded). It surfaces three ways: the `suggest_reviewers` MCP
tool ranks who should review a change (excluding bots, an optional `author`, and the committer
via `git config user.name`); `context` attaches per-candidate `owners`; and the verdict gains a
soft `warnOnForeignCode` policy flag (default off) that warns when a change touches files whose
top author isn't the committer. Deterministic ETL, no model calls.

Phase 5 (widen) is underway. Item 1, **Python graph analysis**, is done. The graph builder is now
a language-agnostic composer over a `LanguageScanner` seam (`graph/scanner.ts`): TypeScript is the
compiler-API scanner, Python is a web-tree-sitter (WASM) scanner whose grammar ships as an asset
(zero-build install). Python imports (absolute/relative/star), module resolution (packages, src/
layouts by config OR convention — src/<pkg> is a root whenever it holds packages, matching flit/
hatch auto-detection — namespace packages), and exports (def/class/assign, `__all__`) are
supported; the cache
(format v2) holds mixed TS+Python repos in one graph — with **no cross-language edges yet** (files
coexist; that's honest, see docs/architecture.md). `get_dependencies`/`get_impact`/`select_tests`
work on Python (`test_*.py`/`*_test.py`/`tests/` selection). The sandbox now EXECUTES Python too:
it picks the runner from the selected tests (pytest for Python, else vitest/jest/node), reuses the
repo's virtualenv (`.venv`/`$VIRTUAL_ENV`), puts the worktree's module roots on `PYTHONPATH`, and
parses the JUnit report with the `keel ci` parser. A broken **conftest.py** (an ImportError while
loading it) is fatal to pytest regardless of `--continue-on-collection-errors`, so the runner uses
a bounded exclude-and-retry loop: detect the offending conftest, record a `collection-error` for
every selected test under its subtree, and re-run with the rest (≤3 retries, each removing ≥1
subtree, budget cumulative). Real failures and collection errors merge; a `failed` status always
carries ≥1 failure — never failed-with-empty. When pytest isn't installed for the chosen
interpreter, `preflight` returns a distinct `runner-unavailable` status naming it (and `verdict`
warns) rather than pretending.

**Go graph analysis** is done (`graph/go-scanner.ts`, a third web-tree-sitter scanner behind the
same seam). Go's model differs in one important way: an import targets a *package* — a directory —
not a file, and a package's non-test `.go` files are one compilation unit. So a Go import edge
goes to *every* non-test `.go` file of the imported package dir; `resolveImport` returns
`string | string[] | null` for this (TS/Python still return one file). Single/factored imports,
aliases, dot-imports (→ `*`) and blank imports (side-effect edge) are parsed; exports are the
capitalized top-level funcs/types/vars/consts with methods attributed to their receiver type;
resolution maps import paths to dirs via each `go.mod`'s module path (`go.work` workspaces =
several discovered modules), excluding `vendor/`/`testdata/` (`internal/` needs no special case).
A same-package `_test.go` file gets a synthetic edge to its package's non-test files; a black-box
`pkg_test` file connects through its explicit import — so a change to a package selects both. **Go
execution** is done too (`simulate/sandbox.ts`): the selected `_test.go` files map to their package
dirs and run in one `go test -json -run . <pkgs>` pass in the worktree, the `-json` stream parsed
into normalized pass/fail (attributed to a test file per package for the graph path). go builds
before it tests, so a compile error IS the executed result — a failure with the compiler output,
not a crash; `go` absent is a `runner-unavailable` status, while `go` present but a failed
toolchain resolution (`GOTOOLCHAIN` download) is a distinct `environment-error` carrying go's
message. Runner dispatch in `runSandbox` is
`isPythonTest` → pytest, `isGoTest` → `go test`, else the JS runners.

**Java graph analysis** is done (`graph/java-scanner.ts`, a fourth web-tree-sitter scanner behind
the same seam). The defining quirk: same-package Java types reference each other with **no import
statement** (a `FooTest` under `src/test/java` exercising `Foo` under `src/main/java`, same
package), so an import-only graph would miss intra-package coupling entirely. keel models a Java
package as one unit like a Go package — but scoped to the build **module** (`graph/java-modules.ts`):
each file emits a synthetic edge to every other file with the same package name **in the same
module** (mutual adjacency; the main↔test link survives because a module's main/test roots share the
scope). Module scoping is essential — a samples monorepo where 50 unrelated projects all declare
`package com.example` would otherwise fuse into one 170-file unit (a real cold-start finding). A
file's module is the nearest ancestor dir with a build file (pom.xml / build.gradle(.kts) /
settings.gradle(.kts)); else the nearest source-root ancestor (dir holding src/main/java|src/test/
java); else its own dir. Real imports on top, **also module-scoped**: single-type (`import a.b.C` →
`C.java`), on-demand (`import a.b.*` → every file of the package → `*`), static imports (member → its
declaring type). A cross-module dep is real but arrives via declared dependencies later, not by
walking every source root. Exports are the public top-level types (class/interface/enum/record/
annotation).
**Java execution** is done too (`simulate/sandbox.ts`): Java tests run per *class* — the selected
files map to FQ class names and run in one `mvn -Dtest=A,B test` / `gradle test --tests A ...` pass,
preferring a repo wrapper (`./mvnw`/`./gradlew`) over a global install. Results come from the
Surefire / Gradle JUnit XML via the existing `keel ci` parser, each failure attributed to its test
file by `classname`. A compile error IS the executed result (a failure with the compiler output,
same rule as Go); no build tool → `runner-unavailable`; a toolchain/dependency fault →
`environment-error`. Runner dispatch in `runSandbox` is now `isPythonTest` → pytest, `isGoTest` →
`go test`, `isJavaTest` → mvn/gradle, else the JS runners.

**Spring DI edges** are done (`graph/spring.ts`), a Java-only graph-enrichment pass adding the
runtime wiring imports can't express: a bean that injects an *interface* imports the interface, not
the concrete bean Spring wires in, so an import-only graph misses it. The pass reads beans
(stereotype annotations), injection points (constructor params, `@Autowired` fields/setters,
Lombok-generated constructors, `@Bean` method params), and each bean's interfaces/superclass, then
edges each injector to every satisfying bean — an interface's impls, a concrete bean, or the
`@Configuration` producing it via `@Bean`. A `@Qualifier("name")` narrows those candidates to the
matching bean (matched against its default decapitalized name, its stereotype value like
`@Service("name")`, or a class-level `@Qualifier`); a qualifier matching nothing keel can see is
ignored rather than dropping the edge. Deterministic; resolution is by simple type name (a
conservative over-approximation — a same-module collision only *adds* edges, safe for blast radius),
and the candidate pool is scoped to the injector's **module** so two same-named beans in different
modules never become each other's candidates (same boundary as adjacency). These edges
are cross-file (an impl reroutes an injector elsewhere), so they compute only in a full
`buildFileGraph`; any `.java` change forces a full rebuild rather than an incremental update, keeping
the cache correct. Graph format bumped to v3 (a v2 cache lacked DI edges).

Phase 5 item 2, the **CI connector + flaky-test detection**, is done (`src/ci/`). `keel ci`
ingests JUnit test reports (the universal CI format; a dependency-free parser) into `ci_run`
events — idempotent, and a re-run that flips on the same commit is a distinct observation.
`ci/flaky.ts` detects flaky tests deterministically: a test that both **passed and failed on the
same commit** (cross-commit disagreement is ordinary history, not flakiness, and is deliberately
not flagged). The `flaky_tests` MCP tool lists them with evidence; the trust layer discounts a
flaky failure — a `verdict` whose only sim failures are known-flaky warns instead of blocking
(`facts.ts` annotates each failure via the flaky matcher). No model calls; graph/sim value still
works with zero CI data (flaky detection just returns empty and nothing is discounted).

**Cross-repo workspaces** are the final Phase 5 item (`src/workspace/`). A `keel.workspace.json`
lists member repos; `keel workspace` builds one graph over them, namespacing each file as
`name::path` and adding the edges that cross repo boundaries. The enabling change is in the per-repo
composer: it now retains each file's **external import specifiers** (the ones that resolved to
nothing in-repo) — `FileGraph.externalImports`, serialized (graph format **v4**). A cross-repo edge
is one member's external specifier matched to what a sibling publishes: TS/JS by package.json
`name` → the package's source entry (mapping a `dist/` manifest entry back to `src/`); Python and Go
by **reusing the sibling repo's own resolver** (absolute imports resolve against that repo's
roots/modules). Edges route by the importing file's language, so no cross-language false matches.
Blast radius crosses repos (`keel workspace impact name::file`). Deterministic, no model calls;
Java cross-repo (jars) deferred. Scope: graph/impact only — execution, decisions, and MCP tools
stay single-repo this pass.

**Unprompted memory** closes the adoption gap that tool descriptions and CLAUDE.md guidance leave
open: agents still answer code questions by reading code and never call `why`. `keel prompt-context`
(`src/retrieval/prompt-context.ts` + `-cli.ts`) is a Claude Code **UserPromptSubmit** hook — it reads
the prompt on stdin, fast-matches it against the decision index (keyword over summaries/rationales +
a *local* query embedding when Ollama answers within ~500ms, hard ~1s total budget), and injects the
matching decisions as `additionalContext` (summary + PR/ADR receipt + linked files, one line each).
It is deliberately **high-precision/low-recall** — silence is the correct output for most prompts: a
match must clear a relevance bar (a *distinctive* keyword overlap — function words and generic repo/
dev vocabulary in an `IGNORED_TERMS` set don't count — or a minimum cosine, `SEMANTIC_HIT`), a prompt
with no distinctive terms is dropped *before* any store read or embedding, and it emits only what
clears the bar (0–3, never padded to a fixed count). Because it runs on every prompt the contract is
strict: no hits → empty output, and it never errors, never blocks, never over-runs the budget (the
embedding is raced and dropped on any slowness, per principle 1). `keel init` installs it by default (`writeSettingsHook` — a non-destructive,
idempotent merge into the target repo's `.claude/settings.json`, `--no-hooks` to skip; mirrors the
same launch command it writes to `.mcp.json`). The stronger `verdict` **Stop** hook is a completion
gate, so it stays opt-in via `recipes/claude-code-hook.md`; this repo dogfoods both in
`.claude/settings.json`. No remote/generative calls.
