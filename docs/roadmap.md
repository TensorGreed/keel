# Roadmap

Sequenced by dependency: substrate → simulator → memory → trust. Each phase ends in a
demo. Work top-to-bottom; keep checkboxes current (same commit as the feature).

## Phase 0 — Substrate skeleton

Goal: an MCP server Claude Code can register, answering graph and history questions
about any TS/JS repo. **Demo:** graph-backed answers on a fresh public repo.

- [x] Repo scaffold: TS strict, ESM, vitest, MCP stdio server
- [x] `get_dependencies` v0: file-level import graph via TS compiler API
- [x] `get_history` v0: git log for a path via child_process
- [ ] Resolve tsconfig path aliases + monorepo workspaces in the graph
- [ ] Symbol-level dependencies: which exports of a file each dependent actually uses
- [ ] Event log v1: SQLite persistence via `node:sqlite`, commits ingested on startup
- [ ] `keel init` UX: one command that registers the server in `.mcp.json`
- [ ] Incremental graph cache keyed by git HEAD (rebuildable from clean clone)

## Phase 1 — Flight simulator MVP

Goal: `preflight(diff)` returns **executed** results, single repo, TS/JS.
**Demo:** "what happens if I rename this field?" answered with real failures in <2 min.

- [ ] Diff → impacted-subgraph mapping (files v0, symbols v1)
- [ ] Test selection: map test files to the source files they cover (imports v0)
- [ ] Sandbox runner: apply diff in a temp git worktree, run selected tests (vitest/jest)
- [ ] Budget caps: max tests, max wall time; caps always reported in output
- [ ] `preflight` MCP tool: { impacted, testsSelected, executed, failures[] }
- [ ] Failure report: trace + the graph path from change to failure

## Phase 2 — Team memory

Goal: `why(path)` answers with mined decision records and receipts.
**Demo:** "why is this like this?" → actual PR thread, author, incident links.

- [ ] GitHub connector: backfill PRs + review threads into the event log
- [ ] Decision miner: local model (Ollama) or batch Haiku; prompt + eval fixture set
- [ ] Decision records linked to graph nodes; embeddings for retrieval (local model)
- [ ] `why` MCP tool with source links; pin/correct mechanism (human override wins)
- [ ] Incremental mining on new PRs (cost target: <$0.25/day for 50 PRs)

## Phase 3 — Trust layer

Goal: policy verdicts that let agents take bigger changes safely.
**Demo:** an agent completes a cross-cutting refactor gated by Keel and auto-merges.

- [ ] Verdict object: blast radius, sim status, decision conflicts
- [ ] Policy file format (`keel.policy.json`) + evaluator (pure, no model calls)
- [ ] `verdict` MCP tool; GitHub check integration
- [ ] Claude Code hook recipe: call `preflight`/`verdict` before proposing changes

## Later

More languages (tree-sitter), cross-repo/service graphs, CI + Jira + incident
connectors, team deployment, policy sharing.
