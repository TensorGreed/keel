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

- **v0:** file-level import graph via the TypeScript compiler API
  (`ts.preProcessFile` + module resolution). Cheap, correct, zero config.
- **v1:** symbol-level edges (which export is actually used), tsconfig path aliases,
  monorepo workspaces.
- **v2 (now):** a language-agnostic composer over a `LanguageScanner` seam
  (`src/graph/scanner.ts`). Each scanner owns a set of extensions and answers two questions
  about a file — parse (imports + symbols + exports) and resolve (specifier → in-repo file).
  TypeScript is the compiler-API scanner; **Python** is a tree-sitter scanner using
  web-tree-sitter (WASM, so `npm install` compiles nothing; the grammar ships as an asset).
  The graph is persisted incrementally, keyed by git HEAD.

**Multi-language, one graph — no cross-language edges yet.** A repo's TS and Python files live
in the same graph and coexist, but keel does not model edges *between* languages (e.g. a Python
service shelling out to a Node script, or an FFI boundary). That's honest: such edges aren't
import edges and inferring them reliably is future work. Within each language the graph is
complete; across languages, files simply sit side by side.

**Execution now covers TS/JS and Python.** Graph analysis, impact, and test selection are
language-agnostic (`test_*.py` / `*_test.py` / `tests/` selection for Python). The sandbox
runner picks the runner from the selected tests: **pytest** for Python, else vitest / jest /
node. A change's covering tests are one language (there are no cross-language edges), so the
selection is homogeneous. The pytest run reuses the repo's virtualenv when present (`.venv/bin/
python` or `$VIRTUAL_ENV` — the Python analog of the node_modules symlink), puts the worktree's
module roots on `PYTHONPATH` so the change under test is what runs, and parses the JUnit report
with the same parser `keel ci` uses. It runs with `--continue-on-collection-errors` so one
broken sub-project (e.g. an `examples/` tree importing a package not in the venv) can't abort
the whole run: those surface as their own `collection-error` failure records, coexisting with
the real results. When pytest isn't installed for the chosen interpreter, `preflight` returns a
distinct `runner-unavailable` status naming the interpreter (and `verdict` warns) rather than
pretending to have executed anything — proof over prediction.

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
