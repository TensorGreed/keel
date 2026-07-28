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
                    verdict, report
  serve.ts          Starts the MCP server over stdio; ingests commits first
  init.ts           `keel init`: register keel in a project's .mcp.json
  mcp/tools.ts      Tool definitions + zod schemas (get_dependencies, get_impact,
                    select_tests, preflight, why, verdict, context, suggest_reviewers,
                    get_history)
  graph/            System graph, language-agnostic composer + a per-language scanner seam:
                    scanner.ts (LanguageScanner interface), typescript-scanner.ts (TS compiler
                    API), python-scanner.ts (web-tree-sitter WASM, grammar in graph/wasm/),
                    scanners.ts (registry by extension + async init), dependencies.ts (walk +
                    resolve + assemble), cache.ts (incremental, git-HEAD-keyed graph cache)
  simulate/         Flight simulator: impact.ts (diff -> impacted subgraph),
                    select-tests.ts (impacted -> covering test files),
                    sandbox.ts (apply diff in a temp worktree, run the tests),
                    preflight.ts (impact -> select -> sandbox, budgeted)
  github/           `keel ingest`: backfill PRs + review threads into the event log
                    (remote.ts, client.ts over global fetch, ingest.ts ETL — no deps);
                    check.ts publishes a verdict as a GitHub check run (verdict --github-check)
  ci/               `keel ci`: ingest JUnit test reports into ci_run events (junit.ts parser,
                    ingest.ts ETL, cli.ts — no deps). Feeds flaky-test detection. No model calls.
  mining/           `keel mine`: extract decision records from PR threads (OFFLINE only).
                    The one place model calls are allowed — Ollama or batch Haiku,
                    injectable DecisionModel; never reached from the MCP server
  retrieval/        Decision index: embed.ts (local embeddings, injectable),
                    index.ts (retrieve by graph node or meaning), why.ts (the `why` tool's
                    composition — file links + semantic/keyword, human overrides, receipts)
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
test/               Vitest; fixtures under test/fixtures/
```

## Conventions

- ESM imports with `.js` extensions in source (NodeNext resolution).
- Every MCP tool: zod input schema, structured JSON output, graceful errors as
  `{ error: string }` — never throw across the protocol boundary.
- No native-module dependencies unless unavoidable (keeps install friction near zero).
- Tests colocated under `test/`, named `*.test.ts`. New tool = new test.
- Commits: imperative subject, body explains *why*. Update `docs/roadmap.md` checkboxes
  in the same commit as the feature.

## Where we are

Phase 0 (substrate skeleton) is complete. `get_dependencies` walks import edges via the
TS compiler API (with tsconfig path aliases, workspace resolution, and symbol-level
usage), served from an incremental graph cache keyed by git HEAD (`graph/cache.ts`);
`get_history` shells out to git log. The event log persists to SQLite (`SqliteEventStore`,
node:sqlite) and ingests commits on startup. `keel init` registers the server in
`.mcp.json`.

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
the model for a no-decision PR. Model calls happen only here (offline) plus a local query
embedding in the server. The `why` MCP tool answers "why is this like this?" for a file or
question, linking decisions through the graph with PR source receipts; `keel decision
add`/`reject` gives humans an override that outranks or suppresses mined records.

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

Phase 5 item 2, the **CI connector + flaky-test detection**, is done (`src/ci/`). `keel ci`
ingests JUnit test reports (the universal CI format; a dependency-free parser) into `ci_run`
events — idempotent, and a re-run that flips on the same commit is a distinct observation.
`ci/flaky.ts` detects flaky tests deterministically: a test that both **passed and failed on the
same commit** (cross-commit disagreement is ordinary history, not flakiness, and is deliberately
not flagged). The `flaky_tests` MCP tool lists them with evidence; the trust layer discounts a
flaky failure — a `verdict` whose only sim failures are known-flaky warns instead of blocking
(`facts.ts` annotates each failure via the flaky matcher). No model calls; graph/sim value still
works with zero CI data (flaky detection just returns empty and nothing is discounted).
