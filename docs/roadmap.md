# Roadmap

Sequenced by dependency: substrate → simulator → memory → trust. Each phase ends in a
demo. Work top-to-bottom; keep checkboxes current (same commit as the feature).

## Phase 0 — Substrate skeleton

Goal: an MCP server Claude Code can register, answering graph and history questions
about any TS/JS repo. **Demo:** graph-backed answers on a fresh public repo.

- [x] Repo scaffold: TS strict, ESM, vitest, MCP stdio server
- [x] `get_dependencies` v0: file-level import graph via TS compiler API
- [x] `get_history` v0: git log for a path via child_process
- [x] Resolve tsconfig path aliases + monorepo workspaces in the graph
- [x] Symbol-level dependencies: which exports of a file each dependent actually uses
- [x] Event log v1: SQLite persistence via `node:sqlite`, commits ingested on startup
- [x] `keel init` UX: one command that registers the server in `.mcp.json`
- [x] Incremental graph cache keyed by git HEAD (rebuildable from clean clone)

## Phase 1 — Flight simulator MVP

Goal: `preflight(diff)` returns **executed** results, single repo, TS/JS.
**Demo:** "what happens if I rename this field?" answered with real failures in <2 min.

- [x] Diff → impacted-subgraph mapping (files v0, symbols v1)
- [x] Test selection: map test files to the source files they cover (imports v0)
- [x] Sandbox runner: apply diff in a temp git worktree, run selected tests (vitest/jest)
- [x] Budget caps: max tests, max wall time; caps always reported in output
- [x] `preflight` MCP tool: { impacted, testsSelected, executed, failures[] }
- [x] Failure report: trace + the graph path from change to failure

## Phase 2 — Team memory

Goal: `why(path)` answers with mined decision records and receipts.
**Demo:** "why is this like this?" → actual PR thread, author, incident links.

- [x] GitHub connector: backfill PRs + review threads into the event log
- [x] Decision miner: local model (Ollama) or batch Haiku; prompt + eval fixture set
- [x] Decision records linked to graph nodes; embeddings for retrieval (local model)
- [x] `why` MCP tool with source links; pin/correct mechanism (human override wins)
- [x] Incremental mining on new PRs (cost target: <$0.25/day for 50 PRs)

## Phase 3 — Trust layer

Goal: policy verdicts that let agents take bigger changes safely.
**Demo:** an agent completes a cross-cutting refactor gated by Keel and auto-merges.

- [x] Verdict object: blast radius, sim status, decision conflicts
- [x] Policy file format (`keel.policy.json`) + evaluator (pure, no model calls)
- [x] `verdict` MCP tool; GitHub check integration (`keel verdict --github-check`, recipes/github-check.md)
- [x] Claude Code hook recipe: `keel verdict` as a Stop hook (recipes/claude-code-hook.md)

## Phase 4 — Compose: more value from the substrate

Goal: higher-order tools that compose the graph, sim, and decision index into answers a
caller would otherwise assemble by hand. **Demo:** "brief me on this task" returns the files,
tests, decisions, and risks for a change before a line is written.

- [x] Context briefing tool: one call maps a task to its candidate files, blast radius, tests,
      decisions, and risks (compose get_dependencies + why + select_tests, ranked)
- [x] Architectural import rules in policy + verdict: forbidden `from`→`to` edges block a
      change that introduces or retains them; repo-wide violations reported for adoption
      (`keel.policy.json` forbiddenImports, `keel report --arch`)
- [x] Risk hotspot report: rank files by churn × blast radius × coverage gap, so review
      attention goes where a change is most likely to bite (`keel report --hotspots`; also a
      risk flag in the context tool)
- [x] Reviewer / ownership signal: recency-weighted authorship per file from the event log,
      surfaced as the `suggest_reviewers` tool, per-candidate owners in `context`, and a
      `warnOnForeignCode` verdict signal (bots excluded)

## Phase 5 — Widen

Goal: the same substrate over more languages, more sources, and more than one repo.
**Demo:** graph + sim answers on a Python service, with decisions mined from its ADRs.

- [x] Python support: tree-sitter (web-tree-sitter WASM) graph extraction alongside the TS
      compiler API, behind a LanguageScanner seam
  - [x] Language seam: LanguageScanner interface; the TS builder moved behind it (pure refactor)
  - [x] Python scanner: imports (abs/relative/star), resolution (packages, src/ layouts by
        config OR convention — the importing file's package tree, then src/<pkg>, then repo
        root, namespace packages last), exports (def/class/assign, __all__); zero-build WASM grammar
  - [x] Multi-language cache + mixed TS+Python repos (one graph, no cross-language edges yet);
        get_dependencies/get_impact/select_tests work on Python
  - [x] pytest sandbox runner: preflight EXECUTES Python (reuses the repo venv, PYTHONPATH to the
        worktree, JUnit parsed by the `keel ci` parser); pytest absent → `runner-unavailable`
        naming the interpreter, never a crash
- [x] Go support: tree-sitter-go (WASM, zero-build) graph extraction + `go test` execution,
      behind the LanguageScanner seam
  - [x] Go scanner: imports target PACKAGES (dirs) → an edge to every non-test .go file of the
        package (one compilation unit); single/factored imports, aliases, dot (→ "*") and blank
        (side-effect) imports; exports = capitalized top-level funcs/types/vars/consts, methods
        attributed to their receiver type; resolution via go.mod module path + go.work
        workspaces; vendor/ and testdata/ excluded
  - [x] Go test runner: select _test.go (same-package + black-box) via the dependents walk, run
        `go test -json` per package in the sandbox worktree; a compile error IS the executed
        result (surfaced as a failure); go absent → `runner-unavailable`
- [x] CI connector + flaky-test detection: ingest CI runs, flag tests that fail
      non-deterministically so the sim can discount them
  - [x] CI connector: `keel ci` ingests JUnit reports into ci_run events (universal, no deps,
        idempotent; a flipped re-run on one commit is a distinct observation)
  - [x] Flaky detection: a test that both passed and failed on the same commit (`flaky_tests`
        tool); the verdict discounts a flaky-only sim failure to a warn instead of blocking
- [ ] ADR ingestion into the decision index: Markdown ADRs as first-class decision records
- [ ] Cross-repo workspaces: one graph spanning multiple repos/services

## Later

Team deployment, policy sharing, incident + Jira connectors, service-level graphs.
