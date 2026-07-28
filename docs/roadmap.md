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
- [ ] Reviewer / ownership signal: who has touched the impacted files (history + CODEOWNERS),
      surfaced as a suggested-reviewer fact on a change

## Phase 5 — Widen

Goal: the same substrate over more languages, more sources, and more than one repo.
**Demo:** graph + sim answers on a Python service, with decisions mined from its ADRs.

- [ ] Python support: tree-sitter graph extraction alongside the TS compiler API
- [ ] CI connector + flaky-test detection: ingest CI runs, flag tests that fail
      non-deterministically so the sim can discount them
- [ ] ADR ingestion into the decision index: Markdown ADRs as first-class decision records
- [ ] Cross-repo workspaces: one graph spanning multiple repos/services

## Later

Team deployment, policy sharing, incident + Jira connectors, service-level graphs.
