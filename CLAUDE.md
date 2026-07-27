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
   permitted only in offline ingestion pipelines (decision mining, embeddings).
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
- **Runtime:** Node >= 22, ESM only, TypeScript strict.
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
  index.ts          CLI entry: dispatches `keel serve` (default) and `keel init`
  serve.ts          Starts the MCP server over stdio; ingests commits first
  init.ts           `keel init`: register keel in a project's .mcp.json
  mcp/tools.ts      Tool definitions + zod schemas (get_dependencies, get_impact,
                    select_tests, get_history)
  graph/            System graph: import/dependency scanning (TS compiler API);
                    cache.ts is the incremental, git-HEAD-keyed graph cache
  simulate/         Flight simulator: impact.ts (diff -> impacted subgraph),
                    select-tests.ts (impacted -> covering test files),
                    sandbox.ts (apply diff in a temp worktree, run the tests)
  git/              Git history + commit listing (child_process, no deps)
  events/           Event log: schema.sql + EventStore (SqliteEventStore via node:sqlite)
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
`.mcp.json`. Next up is Phase 1 (flight simulator) — see `docs/roadmap.md` and pick up the
first unchecked item.
