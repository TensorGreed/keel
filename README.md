# Keel

[![CI](https://github.com/TensorGreed/keel/actions/workflows/ci.yml/badge.svg)](https://github.com/TensorGreed/keel/actions/workflows/ci.yml)

**Your codebase, with memory and foresight.** A development intelligence layer for the agent era,
delivered as an [MCP](https://modelcontextprotocol.io) server.

Coding agents (Claude Code, Copilot, Cursor) can write almost any code you ask for — but they
don't know *why* your system is the way it is, *what actually breaks* if they change it, or
*whether a change is safe to merge*. Keel answers those three questions, and it answers them with
**executed proof and static facts, never model guesses**:

- **Team memory** — "why is this like this?" tied back to the real PR thread, ADR, or decision
  that caused it. Git blame for intent.
- **Flight simulator** — "what breaks if I change this?" answered by *executing* the change against
  the covering tests in a sandboxed worktree. Proof, not prediction.
- **Trust layer** — a machine-checkable `pass | warn | block` verdict (blast radius, executed sim,
  coverage, decision conflicts, architecture rules) so teams can safely turn up agent autonomy.

All three run on one deterministic substrate: an event log, a system graph, and a decision index.
See [docs/concept.md](docs/concept.md) for the vision and [docs/architecture.md](docs/architecture.md)
for the design.

## See it work

Every number below was captured from a real run; reproduce the full hono walkthrough in ~3 minutes
via **[docs/demo.md](docs/demo.md)**.

Pointed at **[honojs/hono](https://github.com/honojs/hono)** (TypeScript, 381 files, commit `224d2f5`):

- *What depends on `Context`?* → `get_dependencies` returns a blast radius of **196 files** —
  ~0.75s cold, **~0.3s** warm (cache keyed on git HEAD).
- *What breaks if cookie parsing is off by one char?* → `preflight` **executes** the covering
  tests and returns **43 real failures across 6 files in ~1.8s**, each with the graph path from the
  failing test back to the change.
- *Is it safe to merge?* → `keel verdict` returns **BLOCK** (exit 2), naming the failing tests.

Pointed at **[pallets/flask](https://github.com/pallets/flask)** (Python, 83 files, commit `36e4a82`)
— the same graph, no config: `get_dependencies` on `src/flask/ctx.py` returns a blast radius of
**69 files** in **~0.13s**. One language switch, zero setup.

## Status

**Phases 0–5 complete** — substrate, flight simulator, team memory, trust layer, compose, and widen.
Four languages, with **graph analysis** (imports, blast radius, test selection) and **execution**
(preflight runs the covering tests; verdict gates on the result) stated honestly per language:

| Language | Graph analysis | Execution (preflight / verdict) |
|---|---|---|
| **TypeScript / JavaScript** | TS compiler API: imports, tsconfig path aliases, npm workspaces, symbol-level usage | vitest / jest / `node --test` |
| **Python** | tree-sitter: absolute/relative/star imports, `src/` layouts, namespace packages | `pytest` (reuses the repo's venv); survives broken conftests |
| **Go** | tree-sitter: a package is one compilation unit; `go.mod` / `go.work` resolution | `go test -json` per package; a compile error is an executed failure |
| **Java** | tree-sitter: a package is one unit (incl. `src/test` ↔ `src/main`); **Spring DI edges** (an injected interface → every impl Spring wires in) | `mvn` / `gradle`, preferring the repo wrapper; Surefire/Gradle XML |

When a runner or toolchain isn't available, Keel says so (`runner-unavailable` / `environment-error`)
rather than pretending it passed. Cross-repo workspaces span all four languages at the graph/impact
layer; execution stays single-repo.

## Tools

MCP tools an agent calls (zod-validated input, structured JSON out, errors returned as data):

| Tool | Answers | Backed by |
|---|---|---|
| `get_dependencies` | what imports this / what it imports / full blast radius / symbol-level usage | static graph |
| `get_impact` | a diff → its impacted subgraph (symbol-narrowed) | static graph |
| `select_tests` | the test files covering a change, and what's left uncovered | static graph |
| `preflight` | apply the diff in a worktree, run the covering tests → **executed** pass/fail with traces + graph path | sandboxed execution |
| `verdict` | `pass \| warn \| block`, each reason naming its rule + fact (blast radius, sim, coverage, decisions, `forbiddenImports`) | policy eval |
| `why` | the decision behind a file or question, with PR/ADR receipts | decision index |
| `context` | one-call task briefing: candidate files + blast radius, tests, decisions, owners, risks | composition |
| `suggest_reviewers` | who should review a change, by recency-weighted authorship (bots excluded) | event log |
| `flaky_tests` | tests CI proved non-deterministic (passed *and* failed on one commit) | CI reports |
| `get_history` | git history for a path — the raw material for "why" | git |
| `workspace_impact` | cross-repo blast radius (only when a `keel.workspace.json` is present) | workspace graph |

CLI (offline, deterministic — `keel <cmd>`, or `npx -y @tensorgreed/keel <cmd>`):

| Command | Does |
|---|---|
| `serve` (default) | start the MCP server over stdio |
| `init` | register keel in `.mcp.json`, add CLAUDE.md guidance, install the prompt-context hook |
| `ingest` | ADRs (docs/adr, docs/decisions — local) + GitHub PRs into the event log |
| `mine` | extract decision records from ingested PR threads (offline model only) |
| `decision` | record a human decision (`add`) or reject a mined one |
| `ci` | ingest JUnit reports (for flaky-test detection) |
| `verdict` | `pass/warn/block` a change; exit codes for CI, `--hook`, `--github-check` |
| `prompt-context` | Claude Code UserPromptSubmit hook: inject decisions relevant to the prompt |
| `report` | repo-wide `--arch` (import-rule violations) / `--hotspots` (risk ranking) |
| `workspace` | one dependency graph across repos; `impact` / `deps` across boundaries |

## Quick start

Requires Node ≥ 22.13. In the repo you want Keel to understand:

```bash
npx -y @tensorgreed/keel init   # registers keel in this repo's .mcp.json
```

Restart Claude Code (or your MCP client), then ask *"what's the blast radius of changing
src/config.ts?"* — it calls Keel and answers from the graph. `init` wires the config to run via
`npx` if the `keel` binary isn't on your PATH, so there's nothing to install globally.

Optional, progressive enrichment (never prerequisites): `keel ingest` + `keel mine` populate `why`;
a `keel.policy.json` tightens `verdict`; a `keel.workspace.json` turns on cross-repo analysis.

## Mining decisions — model providers

`keel mine` extracts the "why" from ingested PR threads. It is the **only** part of Keel that calls a
generative model, and it runs **offline** — never in the MCP server your agent talks to (a
non-negotiable cost/privacy rule). Three interchangeable backends over `--model`:

| Provider | Config | Cost |
|---|---|---|
| `ollama` (default) | `KEEL_MINER_MODEL` (default `llama3.2`), `KEEL_OLLAMA_URL` | **free, local, private** |
| `anthropic` | `ANTHROPIC_API_KEY`; `KEEL_MINER_MODEL` (default `claude-haiku-4-5`) | paid API (Haiku-class) |
| `openai` (OpenAI-compatible) | `OPENAI_API_KEY`; `KEEL_MINER_MODEL` (**required, no default**); `KEEL_OPENAI_BASE_URL` | paid API |

The `openai` backend is any OpenAI-compatible `/chat/completions` endpoint — the base URL selects the
provider, so one backend serves OpenAI, **DeepSeek**, Groq, Mistral, or a local LM Studio / vLLM:

```bash
OPENAI_API_KEY=sk-... KEEL_OPENAI_BASE_URL=https://api.deepseek.com/v1 \
  KEEL_MINER_MODEL=deepseek-chat  keel mine --model openai
```

**Cost posture.** Local (`ollama`) is the default and the only backend that runs for free; a cloud
provider is opt-in via `--model` and never has a silent model default. Before mining more than 25 PRs
on a paid API, Keel prints the count and a rough token estimate to stderr so a bill is never a
surprise, and an auth/rate-limit/5xx error stops cleanly, leaving those PRs unmarked so a re-run
retries them.

## How it compares

Code-search and context tools (grep, embeddings, RAG retrievers) return **text** — snippets that
*look* relevant. Keel returns **facts and executed results**:

- **Deterministic** — the graph, impact, and verdict are static analysis and policy evaluation, not
  an LLM's opinion; the same input always gives the same answer, and you can audit why.
- **Executed** — when Keel says a change breaks something, it's because it *ran the test and it
  failed*, with the trace and the import path back to your change. Proof over prediction.
- **Local-first** — no flagship-model calls server-side, ever; Keel hands compact facts to your
  agent and lets *it* reason. Everything works with nothing but a git clone; connectors (GitHub, CI)
  are enrichment. Your code never leaves your machine for Keel to do its job.

## From source

```bash
git clone https://github.com/TensorGreed/keel.git && cd keel
npm install && npm run build && npm test
node dist/index.js init --command "node ./dist/index.js"   # point a repo at this build
```

This repo dogfoods itself: its own `.mcp.json`, `keel.policy.json`, a `verdict` Stop hook and a
`prompt-context` UserPromptSubmit hook (`.claude/settings.json`) gate every change to Keel with
Keel and surface its own decision memory as you work.

## Releasing

Releases publish to npm from CI via **trusted publishing** (OIDC — no npm token stored). A `v*` tag
fires [`.github/workflows/release.yml`](.github/workflows/release.yml): install, build, test, then
`npm publish --provenance`. To cut one: bump `version` in `package.json`, commit, `git tag v0.1.1 &&
git push origin v0.1.1`.

## Principles

No flagship-model calls server-side, ever. Deterministic core: static analysis, ETL, and executed
tests — never LLM guesses. Repo-only value first; connectors are progressive enrichment. Proof over
prediction. Details in [CLAUDE.md](CLAUDE.md).
