# Keel

[![CI](https://github.com/TensorGreed/keel/actions/workflows/ci.yml/badge.svg)](https://github.com/TensorGreed/keel/actions/workflows/ci.yml)

**Your codebase, with memory and foresight.**

Keel is a development intelligence layer for the agent era, delivered as an MCP server.
Coding agents (Claude Code, Copilot, Cursor) can write almost any code you ask for —
but they don't know *why* your system is the way it is, *what actually happens* if they
change it, or *whether a change is safe to automate*. Keel answers those three questions:

- **Team memory** — "why is this like this?" answered with the real PR thread, ADR, or
  incident that caused it. Git blame for intent.
- **Flight simulator** — "what breaks if I change this?" answered by *executing* the
  change against the dependents' tests in a sandbox. Proof, not prediction.
- **Trust layer** — machine-checkable verdicts (blast radius, sim status, decision
  conflicts) that let teams safely turn up agent autonomy.

All three run on one substrate: an event log, a system graph, and a decision index.
See [docs/concept.md](docs/concept.md) for the vision and
[docs/architecture.md](docs/architecture.md) for the design.

## See it work

Pointed at [honojs/hono](https://github.com/honojs/hono) (381 source files), from a cold start:

- **What depends on `Context`?** → `get_dependencies` returns a blast radius of **196 files** in **~0.3s**.
- **What breaks if cookie parsing is off by one char?** → `preflight` **executes** the covering
  tests and returns **43 real failures across 6 files in ~1.8s**, each with the graph path from
  the failing test back to the change.
- **Is it safe to merge?** → `keel verdict` returns **BLOCK** (exit 2), naming the failing tests.

Full walkthrough with copy-pasteable commands: **[docs/demo.md](docs/demo.md)**.

## Status

Phases 0–3 complete (substrate, flight simulator, team memory, trust layer). Working today,
for TypeScript/JavaScript repos:

- `get_dependencies` — import graph with transitive blast radius and symbol-level usage
- `get_impact` — map a diff to its impacted subgraph (symbol-narrowed)
- `select_tests` — the test files that cover a change, and what's left uncovered
- `preflight` — validate a diff, apply it in an isolated worktree, and run the covering
  tests under hard budget caps: **executed** pass/fail with traces and the graph path from
  each failure back to the change
- `why` — the decision behind a file or answer to a question, with PR source receipts
  (`keel ingest` + `keel mine` populate it; `keel decision add`/`reject` for human overrides)
- `verdict` — a machine-checkable **pass | warn | block** on a change, composing blast
  radius, the executed sim, coverage, and affected decisions against `keel.policy.json`.
  Also runs from the shell as `keel verdict`: exit codes for CI, `--hook` to gate Claude Code
  ([recipes/claude-code-hook.md](recipes/claude-code-hook.md)), and `--github-check` to post
  the verdict as a GitHub check on every PR ([recipes/github-check.md](recipes/github-check.md))
- `get_history` — git history for any path

See [docs/roadmap.md](docs/roadmap.md) for what's next (post-Phase-3: more languages,
cross-repo graphs, CI/Jira/incident connectors).

## Quick start

Requires Node ≥ 22. In the repo you want Keel to understand:

```bash
npx -y @tensorgreed/keel init   # registers keel in this repo's .mcp.json
```

Restart Claude Code (or your MCP client), then ask things like *"what's the blast radius of
changing src/config.ts?"* — it will call Keel and answer from the graph. `keel init` detects
whether the `keel` binary is on your PATH and otherwise wires the config to run via `npx`, so
there's nothing to install globally.

### From source (contributors, or before the npm release)

```bash
git clone https://github.com/TensorGreed/keel.git
cd keel
npm install
npm run build
npm test
node dist/index.js init --command "node ./dist/index.js"   # point a repo at this build
```

This repo dogfoods itself: its own `.mcp.json`, `keel.policy.json`, and a `verdict` Stop hook
(`.claude/settings.json`) gate every change to Keel with Keel.

## Principles

No flagship-model calls server-side, ever — Keel returns compact facts and lets the
caller's agent do the reasoning. Deterministic core: static analysis, ETL, and executed
tests, never LLM guesses. Repo-only value first: everything works with nothing but a
git clone. Details in [CLAUDE.md](CLAUDE.md).
