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

Phases 0–3 complete (substrate, flight simulator, team memory, trust layer); Phase 4 (compose)
complete; Phase 5 (widen) underway — **Python** now works alongside TS/JS: graph analysis (imports,
dependents, blast radius, test selection) and **execution** — `preflight` runs Python tests under
pytest in the sandbox (reusing the repo's venv). Where pytest isn't installed, it says so honestly
(`runner-unavailable`) rather than pretending. **Go** works too — graph analysis (imports target
packages: an edge to every non-test `.go` file, resolved via `go.mod`/`go.work`) and **execution**
(`preflight` runs `go test -json` per package in the sandbox; a compile error surfaces as a failure
with the compiler output). Working today:

- `get_dependencies` — import graph with transitive blast radius and symbol-level usage
- `get_impact` — map a diff to its impacted subgraph (symbol-narrowed)
- `select_tests` — the test files that cover a change, and what's left uncovered
- `preflight` — validate a diff, apply it in an isolated worktree, and run the covering
  tests under hard budget caps: **executed** pass/fail with traces and the graph path from
  each failure back to the change
- `why` — the decision behind a file or answer to a question, with PR source receipts
  (`keel ingest` + `keel mine` populate it; `keel decision add`/`reject` for human overrides)
- `context` — a one-call briefing for a task: the candidate files, each with blast radius,
  covering tests, recent history, linked decisions, and owners, plus rolled-up suggested tests
  and risk flags (uncovered / high-blast-radius / protected-path / top-hotspot). Composition
  only, no LLM calls
- `suggest_reviewers` — who should review a change, ranked by recency-weighted authorship of the
  files it touches (from commit + PR history), excluding bots and the change's own author
- `flaky_tests` — tests CI has proven non-deterministic (passed and failed on the *same* commit),
  from JUnit reports ingested by `keel ci`; the verdict discounts a flaky-only sim failure to a
  warn instead of blocking on it
- `verdict` — a machine-checkable **pass | warn | block** on a change, composing blast
  radius, the executed sim, coverage, affected decisions, and **architectural import rules**
  (`forbiddenImports`: a change that introduces or retains a forbidden `from`→`to` edge blocks,
  naming the exact edge) against `keel.policy.json`. Also runs from the shell as `keel verdict`:
  exit codes for CI, `--hook` to gate Claude Code
  ([recipes/claude-code-hook.md](recipes/claude-code-hook.md)), and `--github-check` to post
  the verdict as a GitHub check on every PR ([recipes/github-check.md](recipes/github-check.md)).
  `keel report` gives repo-wide reports: `--arch` lists import-rule violations (adopt rules on a
  legacy repo), `--hotspots` ranks files by risk = churn × blast radius × coverage gap
- `get_history` — git history for any path

See [docs/roadmap.md](docs/roadmap.md) for what's next (Phase 5 — widen: Python via
tree-sitter, a CI connector + flaky-test detection, ADR ingestion, cross-repo workspaces).

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

## Releasing

Releases publish to npm from CI via **npm trusted publishing** (OIDC) — no npm token is ever
stored as a secret. [`.github/workflows/release.yml`](.github/workflows/release.yml) fires on a
`v*` tag: it installs, builds, runs the full test suite, then `npm publish --provenance` (the
provenance attestation is signed with GitHub's OIDC identity).

**One-time setup** (a maintainer, once):

1. **Create the package.** Trusted publishing is configured on an existing package, so publish
   the first version manually from a maintainer's machine: `npm publish --access public` (this
   is the manual `0.1.0` step). Every release after this is automated.
2. **Register the trusted publisher** on [npmjs.com](https://www.npmjs.com): open the
   `@tensorgreed/keel` package → **Settings → Trusted Publishing → Add GitHub Actions** and set
   - Organization / repository: `TensorGreed/keel`
   - Workflow filename: `release.yml`

   No secret is added to the GitHub repo — the `id-token: write` permission in the workflow is all
   that's needed.

**To cut a release:** bump `version` in `package.json`, commit, then tag and push:

```bash
git tag v0.1.1
git push origin v0.1.1
```

CI takes it from there. (`prepublishOnly` re-runs build + tests as a final guard before publish.)

## Principles

No flagship-model calls server-side, ever — Keel returns compact facts and lets the
caller's agent do the reasoning. Deterministic core: static analysis, ETL, and executed
tests, never LLM guesses. Repo-only value first: everything works with nothing but a
git clone. Details in [CLAUDE.md](CLAUDE.md).
