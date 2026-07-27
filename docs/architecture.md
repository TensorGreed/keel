# Architecture

Keel is one substrate with three capability layers, delivered as an MCP server.
See `concept.md` for the product rationale; this doc is the engineering view.

```
┌────────────────────────────────────────────────────────┐
│                    DELIVERY: MCP SERVER                │
│   (Claude Code / Copilot / Cursor call Keel as a tool) │
├────────────┬──────────────────────┬────────────────────┤
│  MEMORY    │   FLIGHT SIMULATOR   │    TRUST LAYER     │
│  queries   │   executes against   │   policies over    │
│  decision  │   the system graph   │   memory + sim     │
│  index     │   in sandboxes       │   results          │
├────────────┴──────────────────────┴────────────────────┤
│                     THE SUBSTRATE                      │
│    EVENT LOG      │   SYSTEM GRAPH   │  DECISION INDEX │
└────────────────────────────────────────────────────────┘
```

## Substrate components

### System graph (`src/graph/`)
Nodes: files, exported symbols, API endpoints, DB tables (later: services).
Edges: imports, calls, reads/writes, exposes.

- **v0 (now):** file-level import graph via the TypeScript compiler API
  (`ts.preProcessFile` + module resolution). Cheap, correct, zero config.
- **v1:** symbol-level edges (which export is actually used), tsconfig path aliases,
  monorepo workspaces.
- **v2:** tree-sitter based extraction for additional languages; persist the graph
  incrementally instead of rebuilding.

Design rule: the graph must always be rebuildable from a clean clone. Persistence is a
cache, never the source of truth.

### Event log (`src/events/`)
Append-only, normalized timeline: commits, PRs, review comments, CI runs, deploys,
incidents, **and Keel's own simulation results**. Schema in `schema.sql`.

- **v0 (now):** schema + `EventStore` interface, in-memory impl. Git commits are read
  directly via `src/git/` rather than through the store.
- **v1:** SQLite persistence (`node:sqlite`), GitHub backfill connector (PRs + reviews).
- Ingestion is plain ETL — no LLM calls in this layer.

### Decision index (Phase 2)
Decision records mined from PR threads/ADRs/tickets, linked to graph nodes, embedded
for retrieval. Mining runs offline with local (Ollama) or batch Haiku-class models —
see the cost rules in `CLAUDE.md`. Humans can pin/correct records; corrections win.

## Capability layers

### `get_dependencies` / impact queries (now)
Given a file (later: symbol), return direct + transitive dependents from the graph.
This is the read API the simulator uses to scope work.

### Flight simulator (Phase 1)
Input: a diff (or described change). Steps: map the diff to graph nodes → compute the
impacted subgraph → select the test files that cover it → apply the diff in an isolated
worktree/container → run only those tests → return failures with traces. Budgeted:
hard caps on test count and wall time per query, always reported in the output.

### Trust layer (Phase 3)
Pure policy evaluation over structured facts: blast-radius size, sim verdict, decision
conflicts. No model calls. Output is a machine-checkable verdict object that a CI check
or an agent hook can gate on.

## MCP surface (grows by phase)

| Tool | Phase | Contract |
|---|---|---|
| `get_dependencies` | 0 | file → { dependencies, dependents, transitiveDependents } |
| `get_history` | 0 | path → recent commits touching it (author, date, subject) |
| `preflight` | 1 | diff → { impacted, testsSelected, executed, failures[] } |
| `why` | 2 | path/symbol → decision records with sources |
| `verdict` | 3 | diff → { blastRadius, simStatus, decisionConflicts, policy } |

All tools: zod-validated input, JSON output, errors returned as data (`{ error }`).
