# Keel

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

```bash
npm install
npm run build
npm test
```

Register with Claude Code (in your target repo's `.mcp.json`):

```json
{
  "mcpServers": {
    "keel": {
      "command": "node",
      "args": ["/path/to/keel/dist/index.js"],
      "env": { "KEEL_REPO": "." }
    }
  }
}
```

Then ask your agent things like *"what's the blast radius of changing src/config.ts?"*
— it will call Keel and answer from the graph.

## Principles

No flagship-model calls server-side, ever — Keel returns compact facts and lets the
caller's agent do the reasoning. Deterministic core: static analysis, ETL, and executed
tests, never LLM guesses. Repo-only value first: everything works with nothing but a
git clone. Details in [CLAUDE.md](CLAUDE.md).
