# Changelog

All notable changes to Keel are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Keel is pre-1.0: the MCP tool surface and the `keel.policy.json` / `keel.workspace.json`
schemas may still change between minor versions. Breaking changes are called out under
**Changed** with a migration note.

## [0.1.1] — unreleased

The "widen and harden" release: three more languages, higher-order tools that compose the
substrate, memory that surfaces itself without being asked, and a pass over every way the
process could hang, corrupt state, or carry hostile text into an agent's context.

### Added

#### Languages under analysis

- **Python graph analysis.** The graph builder is now a language-agnostic composer over a
  `LanguageScanner` seam; Python arrives as a `web-tree-sitter` (WASM) scanner whose grammar
  ships as an asset, so install stays build-free. Imports (absolute, relative, star), module
  resolution (packages, `src/` layouts by config *or* convention, namespace packages) and
  exports (`def` / `class` / assignment, `__all__`) are supported, and
  `get_dependencies` / `get_impact` / `select_tests` all work on Python.
- **Python execution.** `preflight` runs pytest for real: it picks the runner from the
  selected tests, reuses the repo's virtualenv (`.venv` / `$VIRTUAL_ENV`), puts the
  worktree's module roots on `PYTHONPATH`, and parses the JUnit report with the `keel ci`
  parser. A broken `conftest.py` is survived by a bounded exclude-and-retry loop rather than
  collapsing the whole run.
- **Go graph analysis and execution.** A Go import targets a *package* — a directory — so an
  import edge goes to every non-test `.go` file of the imported package. Single and factored
  imports, aliases, dot-imports and blank (side-effect) imports are parsed; resolution maps
  import paths to directories via each `go.mod` (with `go.work` workspaces), excluding
  `vendor/` and `testdata/`. Selected `_test.go` files run in one `go test -json` pass in the
  sandbox worktree, with the `-json` stream parsed into normalized pass/fail.
- **Java graph analysis and execution.** Same-package Java types reference each other with no
  import statement, so Keel models a Java package as one unit — scoped to the build module —
  in addition to real single-type, on-demand and static imports. Tests run per class via
  `mvn -Dtest=…` / `gradle test --tests …`, preferring a repo wrapper (`./mvnw`, `./gradlew`)
  over a global install, with results read from Surefire / Gradle JUnit XML.
- **Spring DI edges.** A Java graph-enrichment pass adds the runtime wiring imports cannot
  express: beans (stereotype annotations), injection points (constructor params,
  `@Autowired` fields and setters, Lombok-generated constructors, `@Bean` method params), and
  interface→implementation resolution, so an injected interface edges to every implementation
  and a `@Bean`-produced type edges to its `@Configuration`. `@Qualifier` narrows the
  candidates; a qualifier matching nothing visible is ignored rather than dropping the edge.

#### Tools

- **`context` MCP tool.** One call takes a free-text task (plus any files the caller already
  knows) and returns a briefing: candidate files ranked by relevance, each with blast radius,
  key dependents, recent history, linked decisions with receipts and covering tests — rolled
  up into `suggestedTests`, `relevantDecisions` (human-authored first) and `risks`.
- **`suggest_reviewers` MCP tool** and per-file ownership, from recency-weighted commit + PR
  authorship in the event log (half-life 180 days, bots excluded). Also surfaced as
  per-candidate `owners` in `context` and as an opt-in `warnOnForeignCode` verdict signal.
- **`flaky_tests` MCP tool.** Lists tests that both passed *and* failed on the same commit,
  with the evidence. Cross-commit disagreement is ordinary history and is deliberately not
  flagged.
- **`workspace_impact` MCP tool**, registered when Keel is launched inside a workspace.
- **`keel report`.** `--arch` lists every repo-wide forbidden-import violation
  (informational, exit 0) so a team can adopt a rule on a legacy repo before it gates anyone;
  `--hotspots` ranks files by churn × (blast radius + 1) × coverage gap, showing every
  component rather than just the score. No flag prints both.
- **`keel ci`.** Ingests JUnit test reports — the universal CI format, with a
  dependency-free parser — into `ci_run` events, idempotently. Feeds flaky-test detection.
- **`keel workspace`.** A `keel.workspace.json` lists member repos; Keel builds one graph
  over them, namespacing each file as `name::path` and adding the edges that cross repo
  boundaries. A cross-repo edge is one member's unresolved-in-repo import specifier matched
  to what a sibling publishes: TS/JS by `package.json` `name` → source entry, Python and Go
  by reusing the sibling repo's own resolver. Blast radius crosses repos.
- **`keel prompt-context`.** A Claude Code `UserPromptSubmit` hook that closes the adoption
  gap tool descriptions leave open — agents answer code questions by reading code and never
  call `why`. It fast-matches the prompt against the decision index and injects the matching
  decisions as `additionalContext`. Deliberately high-precision / low-recall: silence is the
  correct output for most prompts. `keel init` installs it by default (`--no-hooks` to skip).
- **`keel doctor`.** One table, one named fix per failing line: Node and git versions, repo
  detection, the event db (openable, with commit / PR / decision counts), graph-cache
  freshness against HEAD, Ollama reachability and whether the embed / miner models are
  pulled, `GITHUB_TOKEN` validity, available test runners, and `.mcp.json` + hook
  registration. `--json` emits the full report; exit 1 if anything is red.
- **ADR ingestion.** `keel ingest` is now dual-source: the GitHub half, plus a **local** half
  that ingests Markdown ADRs under `docs/adr/` and `docs/decisions/` with no network at all.
  MADR-parsed (title / status / context / decision), stored with origin `"adr"` — ranked
  above mined records, below an explicit `keel decision add` — linked to graph nodes by
  repo-relative paths in the body, idempotent by path + content hash, with edits re-ingesting.
- **Architectural import rules.** `keel.policy.json` gains
  `forbiddenImports: [{ from, to, reason }]`; a change that introduces *or retains* a graph
  edge from a `from`-glob file to a `to`-glob file blocks, with the verdict naming the exact
  importer → imported edge and the reason.
- **An OpenAI-compatible mining backend.** `keel mine` can now point at any
  OpenAI-compatible endpoint via `KEEL_OPENAI_BASE_URL` (DeepSeek, Groq, vLLM, …) alongside
  the existing local Ollama default and batch Haiku. Cloud runs over 25 PRs print a cost
  estimate first.
- **Edge provenance.** Every edge in a dependency report carries its kind — `import` (a real
  directed import), `package` (Java/Go same-package unit adjacency) or `di` (Spring wiring) —
  so a mutual `*` edge reads as the model rather than as an analyzer bug.
- **`keel init` writes agent guidance.** Beyond registering the server in `.mcp.json`, it
  appends a "Working with Keel" section to the repo's `CLAUDE.md` behind idempotent markers
  (`--no-claude-md` to skip).
- **Windows support, tested in CI.** The test matrix gains a `windows-latest` leg (Node 22 only,
  to bound minutes) and the suite is green there. Platform differences now live in one place,
  `src/util/platform.ts`: PATHEXT-aware PATH resolution, `.cmd`/`.bat` shims routed through a
  shell with cmd.exe quoting, directory *junctions* instead of symlinks (no elevation needed),
  and one canonical path form for containment checks. A `.gitattributes` pins the working tree
  to LF on every platform, since the fixtures are byte-exact parser inputs. Three test suites
  whose stubs are `#!/bin/sh` scripts skip on Windows with the reason stated; nothing fails.

### Changed

- **`keel ingest` is observable and un-hangable.** It prints the auth mode and target on
  start (validating the token in the process), a progress line per PR page, and bounds every
  request; a stalled proxy now surfaces as the same clean "resume by re-running" stop as a
  rate limit instead of a silent hang.
- **Java package adjacency is scoped to the build module**, not the repo. A samples monorepo
  where 50 unrelated projects all declare `package com.example` previously fused into one
  170-file unit. A file's module is the nearest ancestor directory with a build file, else
  the nearest source-root ancestor, else its own directory; real imports are module-scoped
  too, as is the Spring DI candidate pool.
- **`prompt-context` gates matches on real relevance, not any token overlap.** A match must
  clear a distinctive-keyword bar — function words and generic repo/dev vocabulary are
  excluded — or a minimum cosine; a prompt with no distinctive terms is dropped before any
  store read or embedding; and the hook emits only what clears the bar (0–3), never padded to
  a fixed count.
- **Build-bootstrap failures are classified as environment errors, not test results.** A
  missing runner is `runner-unavailable` naming it, and a toolchain or dependency fault is a
  distinct `environment-error` carrying the tool's own message — never a fabricated failure.
- Graph cache format bumped to **v5** over the course of the release (v2 multi-language, v3
  Spring DI edges, v4 retained external import specifiers, v5 edge provenance). A cache
  written by an older version is discarded and rebuilt.

### Fixed

- **Windows: the JS sandbox runner could not start.** It shelled out to `npx`, which is a `.cmd`
  shim there — and since Node 20.12 `spawn` refuses a `.cmd` without a shell. The runner now
  resolves the installed runner's own JS entry from its `bin` field and runs it with
  `process.execPath`, which is identical on every platform and drops a process layer everywhere.
- **Windows: Maven and Gradle were reported missing when installed.** Both `keel doctor`'s runner
  probe and the Java test runner tried to exec a bare `mvn`/`gradle`, which resolves to a batch
  shim. Presence is now resolved on PATH, and a shim is invoked through cmd.exe.
- **Windows: a timed-out runner leaked its build.** Killing a batch-shim child killed cmd.exe and
  left the real `java`/`go` process running, against the "no hangs, ever" promise; the timeout now
  kills the process tree.
- **A repo reached through a symlink or an 8.3 short path built an empty graph.** Import
  resolution realpaths the files it finds, so every `startsWith(root)` containment check failed
  unless the root was in the same space — which it wasn't for a repo under `%TEMP%` on a CI runner
  (`C:\Users\RUNNER~1\…`) or under macOS's `/var` → `/private/var`. Both sides now go through one
  canonicalization.
- **Windows: the sandbox's shared `node_modules` link.** Created as a junction rather than a
  `"dir"` symlink (which needs Developer Mode or elevation), and explicitly removed during
  teardown so no recursive delete can follow it into the main repo's real tree.
- The pytest runner probes both venv layouts (`bin/python` and `Scripts\python.exe`) for every
  candidate venv, and falls back to `python` rather than `python3` on Windows, where `python3` is
  usually absent or a Store stub.
- Workspace version skew now warns, and the checkout-vs-runtime caveat is documented.
- A `failed` preflight status always carries at least one failure — never failed-with-empty.
- `keel mine` is incremental: it tracks which PRs it has mined under *any* outcome, so a
  re-run never re-charges the model for a no-decision PR.

### Security

- **Every outbound call has a mandatory timeout.** Timeout policy is centralized in
  `src/util/timeouts.ts`, one getter per category (GitHub HTTP, git subprocess, Ollama
  generate, Ollama embed, remote model APIs, sandboxed test runners), each with a `KEEL_*_TIMEOUT`
  env override in seconds. `fetchTimed` / `execFileTimed` / `execFileSyncTimed` wrap the raw
  Node primitives so a call site cannot forget a bound, and anything past 5s writes a
  one-line progress note instead of going quiet. `test/timeout-audit.test.ts` is a static
  registry that fails the build if a raw `fetch(` / `execFile(` / `spawnSync(` appears
  outside the wrapper.
- **Crash-safe and concurrent state.** The SQLite event log opens with `busy_timeout` → WAL →
  `synchronous=NORMAL` (the canonical crash-safe pairing) and takes its write lock up front
  with `BEGIN IMMEDIATE`. Split-write gaps are closed with atomic operations — a crash can no
  longer mark a PR mined without persisting its decision, drop an edited ADR without writing
  its replacement, or leave a half-written embedding batch. The graph cache writes a temp
  file and renames it into place, so a reader never sees a partial cache.
- **Injection defense on decision text.** Mined and ADR text derives from attacker-influenced
  input (PR bodies, review comments, Markdown) and flows into an agent's context via `why`,
  `context` and the prompt-context hook. `src/util/sanitize.ts` makes it inert and bounded —
  C0/C1 control and invisible/directional characters stripped, code fences defused, all
  whitespace flattened to a single line, hard length cap — applied both when storing and when
  emitting. Output is explicitly framed as **DATA, not instructions**, with receipts to verify
  against.

## [0.1.0] — 2026-07-28

First cut: the substrate, the flight simulator, team memory and the trust layer, over
TypeScript/JavaScript repos.

### Added

- **MCP server over stdio** (`@modelcontextprotocol/sdk`), taking the target repo from
  `KEEL_REPO`. `keel init` registers it in a project's `.mcp.json`.
- **System graph** via the TypeScript compiler API: file-level import edges with tsconfig
  path aliases, monorepo workspace resolution, and symbol-level usage (which exports of a
  file each dependent actually uses). Served from an incremental on-disk cache keyed by git
  HEAD.
- **`get_dependencies`** and **`get_history`** MCP tools (the latter shelling out to
  `git log`, no dependencies).
- **Event log v1**: SQLite persistence via `node:sqlite`, with commits ingested on server
  startup.
- **Flight simulator.** `get_impact` maps a diff to its impacted subgraph (symbol-narrowed,
  with an intra-file reference closure); `select_tests` picks the covering test files; and
  `preflight` ties them together — validating the diff with `git apply`, applying it in an
  isolated git worktree and running the selected tests under hard budget caps (max tests, max
  wall time, always reported). Failures come back executed, with the trace and the import
  path from each failing test back to the change.
- **Team memory.** `keel ingest` backfills GitHub PRs and review threads into the event log;
  `keel mine` extracts decision records from them with a local (Ollama) or batch-Haiku model
  and embeds them locally for retrieval. The **`why`** MCP tool answers "why is this like
  this?" for a file or a question, linking decisions through the graph with PR source
  receipts, and `keel decision add` / `reject` gives humans an override that outranks or
  suppresses a mined record.
- **Trust layer.** The **`verdict`** MCP tool composes blast radius, the executed preflight
  sim, uncovered changes and the decisions a change may affect, and evaluates them against
  `keel.policy.json` (conservative defaults if absent) to return a machine-checkable
  `pass` | `warn` | `block`, each reason naming the exact rule and fact that triggered it.
- **`keel verdict` CLI** for CI and hooks: exit codes 0/2/1 for gating, `--json` for the full
  verdict, `--hook` for the Claude Code Stop-hook protocol, and `--github-check` to publish
  the verdict as a GitHub check run on the PR head. Recipes in `recipes/`.
- **CI and release pipelines**: build + test on Node 22 and 24; publish to npm on a `v*` tag
  via trusted publishing (OIDC, with provenance).

[0.1.1]: https://github.com/TensorGreed/keel/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/TensorGreed/keel/releases/tag/v0.1.0
