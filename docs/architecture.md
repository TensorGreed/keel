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
  about a file — parse (imports + symbols + exports) and resolve (specifier → in-repo file(s)).
  TypeScript is the compiler-API scanner; **Python**, **Go**, and **Java** are tree-sitter scanners
  using web-tree-sitter (WASM, so `npm install` compiles nothing; the grammars ship as assets). The
  graph is persisted incrementally, keyed by git HEAD.

**Go resolves to packages, not files — so `resolveImport` returns a set.** TS and Python both
import a single file; Go imports a *package*, which is a directory, and a package's non-test
`.go` files form one compilation unit. So a Go import edge goes from the importing file to
**every non-test `.go` file of the imported package dir** — the seam's `resolveImport` returns
`string | string[] | null` for exactly this, and the composer draws an edge to each resolved
file. Resolution maps an import path to a repo dir through each `go.mod`'s `module` path (a
`go.work` workspace is just several such modules, all discovered); `vendor/` and `testdata/` are
excluded. `internal/` needs no special case — visibility is a compiler concern, and the import
edge is real either way. Exports are the capitalized top-level funcs/types/vars/consts, and a
method attributes to its receiver type's name. A same-package `_test.go` file compiles with the
package but imports nothing from it, so the scanner adds a synthetic edge to the package's
non-test files; a black-box `pkg_test` file connects through its explicit import. Aliased and
dot-imports pull the whole package (`*`); a blank import (`_`) is a side-effect-only edge.

**Java's same-package coupling is invisible to imports — so a package is one unit, like Go.**
In Java, types in the same package reference each other with *no import statement*, and the most
common instance is a `FooTest` in `src/test/java/...` exercising `Foo` in `src/main/java/...` under
the same package. An import-only graph would miss all of this — precisely the intra-package
coupling a change most needs to know about. So keel models a Java package as one unit: every
`.java` file emits a synthetic edge to every other file declaring the **same package name**, across
*all* source roots (mutual adjacency, package-based not directory-based, so the main↔test link
survives the split source layout). On top of that, real import edges: a single-type import
(`import a.b.C`) resolves to the one file `C.java` (the file↔public-type convention); an on-demand
import (`import a.b.*`) resolves to every file of that package (`*`); a static import resolves to
its member's declaring type. Exports are the public top-level types. Resolution maps a package to a
directory under a discovered source root — the Maven/Gradle `src/main/java` and `src/test/java`
convention, with multi-module builds discovered from pom.xml `<modules>` and settings.gradle
`include(...)` (extracted at the regex level; keel takes no XML or build-DSL dependency). Modelling
same-package files as one unit is honest about what Java source expresses, rather than faking a
file-level precision the language doesn't give at the package boundary. (Spring DI wiring between
beans is real coupling that *isn't* an import edge either — that's a separate next pass, not
modelled yet.)

**Multi-language, one graph — no cross-language edges yet.** A repo's TS, Python, Go, and Java
files live in the same graph and coexist, but keel does not model edges *between* languages (e.g. a
Python service shelling out to a Node script, or an FFI boundary). That's honest: such edges
aren't import edges and inferring them reliably is future work. Within each language the graph
is complete; across languages, files simply sit side by side.

**Execution now covers TS/JS, Python, and Go.** Graph analysis, impact, and test selection are
language-agnostic (`test_*.py` / `*_test.py` / `tests/` for Python; `*_test.go` for Go). The
sandbox runner picks the runner from the selected tests: **pytest** for Python, **`go test`** for
Go, else vitest / jest / node. A change's covering tests are one language (there are no
cross-language edges), so the selection is homogeneous. Go tests run per *package*, not per file:
the selected `_test.go` files map to their package dirs and run in one `go test -json -run .
<pkgs>` pass in the worktree, and the `-json` event stream is parsed into the same normalized
pass/fail records (attributed back to a selected test file per package, so a failure keeps its
graph path to the change). The go toolchain builds before it tests, so a **compile error is the
executed result** — surfaced as a failure carrying the compiler output, never a runner crash;
`go` absent is a `runner-unavailable` status naming what was tried; when `go` exists but its
toolchain can't be resolved (a `GOTOOLCHAIN` download fails), that's a distinct
`environment-error` carrying go's own message — an environment fault, not the change's. The
pytest run reuses the repo's virtualenv when present (`.venv/bin/
python` or `$VIRTUAL_ENV` — the Python analog of the node_modules symlink), puts the worktree's
module roots on `PYTHONPATH` so the change under test is what runs, and parses the JUnit report
with the same parser `keel ci` uses. Two shapes of broken sub-project are handled distinctly: a
test *module* that fails to import is a recoverable collection error (`--continue-on-collection-
errors` keeps the run going, and it surfaces as its own `collection-error` record); a broken
**conftest.py**, however, is fatal to the whole session regardless of that flag and yields no
report at all. keel defends with a bounded exclude-and-retry loop — detect the offending conftest
in the output, record a `collection-error` for every selected test under its directory subtree,
and re-run with the rest (at most 3 retries, each provably removing ≥1 subtree, wall-time budget
cumulative). The final result merges real executed failures with the collection errors; status
reflects the executed tests, and by construction a `failed` status always carries at least one
failure — never a silent failed-with-empty-failures. When pytest isn't installed for the chosen
interpreter, `preflight` returns a distinct `runner-unavailable` status naming the interpreter
(and `verdict` warns) rather than pretending to have executed anything — proof over prediction.

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
