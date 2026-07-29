# Recipe: gate Claude Code with `keel verdict`

Make Claude Code check every change against your `keel.policy.json` before it's allowed to
finish. When the change breaks a covering test, touches a protected path, or blows the blast
radius cap, the verdict is **block** — Claude is told exactly what failed and keeps working
instead of handing you a broken change.

This runs on a **Stop hook**: after Claude thinks it's done, Keel runs the verdict on the
working tree. A failing verdict blocks the stop and feeds the reasons back; a pass or warn
lets it finish. Everything is the deterministic trust layer — an executed sim plus pure policy
evaluation, no model calls.

## Prerequisites

- Keel built (`npm run build`) and its event log initialized in the target repo (the server
  ingests commits on first run; `keel init` registers it).
- The repo uses vitest, jest, or `node:test` so the sim can execute covering tests.
- Optional: a `keel.policy.json` at the repo root. Without one, Keel applies a conservative
  default (require the sim to pass; everything else off).

## The hook

`keel verdict --hook` **is** the hook command — it reads the Stop event on stdin and writes
the Stop-hook control JSON on stdout. No wrapper script is needed: it honors
`stop_hook_active` itself, so a block that can't be resolved won't loop the session forever.

Add this to the target repo's `.claude/settings.json` (create the file if it doesn't exist):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "KEEL_REPO=\"$CLAUDE_PROJECT_DIR\" node /absolute/path/to/keel/dist/index.js verdict --hook"
          }
        ]
      }
    ]
  }
}
```

- Replace `/absolute/path/to/keel` with where you cloned Keel (the same path you used in
  `.mcp.json`).
- `KEEL_REPO="$CLAUDE_PROJECT_DIR"` points the verdict at the repo Claude is working in.
  `$CLAUDE_PROJECT_DIR` is set by Claude Code to the project root.

That's it. From now on, when Claude tries to finish:

- **verdict = pass or warn** → the hook prints nothing and exits 0; Claude finishes. Warnings
  are printed to the hook transcript (stderr) so you still see them.
- **verdict = block** → the hook prints `{"decision":"block","reason":"…"}`; Claude Code feeds
  the reason back and Claude keeps working to fix it. The reason lists each failing rule and
  the exact fact behind it (e.g. `requireSimPass: 2 test(s) failed: renders header (Header.test.tsx)`).

### Tuning the sim budget

The verdict runs the covering tests under the same caps as `preflight`. Override them inline:

```jsonc
"command": "KEEL_REPO=\"$CLAUDE_PROJECT_DIR\" node /path/to/keel/dist/index.js verdict --hook --max-tests 30 --max-seconds 90"
```

Or set `KEEL_MAX_TESTS` / `KEEL_MAX_SECONDS` in the hook's environment. If the sim has to skip
tests at the cap, that's surfaced as a warning (or a block, if your policy sets
`forbidTruncatedSim`).

## Companion hook: surface decision memory on every prompt (UserPromptSubmit)

The Stop hook gates a *finished* change. A `UserPromptSubmit` hook works at the other end — when
you send a prompt — and solves a different problem: even with Keel's tools and CLAUDE.md guidance
in place, an agent asked a code question tends to answer by reading code and never calls `why`.
That's rational behavior; this hook stops fighting it and pushes the memory to the agent instead.

`keel prompt-context` reads the prompt on stdin, does a fast match against the decision index
(keyword over decision summaries/rationales, plus local embeddings when Ollama answers quickly,
under a hard ~1s budget), and — only when there are hits — prints the top 3 relevant decisions as
`additionalContext` (each one line: summary, PR/ADR receipt, linked files). No hits → no output.
It never errors, never blocks, and stays under budget: a hook that slows every prompt gets
uninstalled, so silence is the default.

Add it alongside the Stop hook in `.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "KEEL_REPO=\"$CLAUDE_PROJECT_DIR\" node /absolute/path/to/keel/dist/index.js prompt-context"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "KEEL_REPO=\"$CLAUDE_PROJECT_DIR\" node /absolute/path/to/keel/dist/index.js verdict --hook"
          }
        ]
      }
    ]
  }
}
```

It draws on the same decision index as the `why` tool, so it's only as rich as what you've
ingested and mined — with zero decisions it simply stays silent (graph and sim value are
unaffected). Remote/generative calls are never made; the only model touched is a *local* query
embedding, and it's dropped the moment it exceeds the budget.

## Variations

### CI gate instead of a hook

The same command drives a CI check — no `--hook`, just the exit code:

```bash
KEEL_REPO="$PWD" node /path/to/keel/dist/index.js verdict   # exit 2 = block, 0 = pass/warn, 1 = error
```

Add `--json` for the full machine-readable verdict (blast radius, per-rule reasons, the sim
result, and which policy applied) to post as a PR comment or check output.

### Judge a specific diff

By default the verdict judges the working tree. To judge a proposed patch instead:

```bash
node /path/to/keel/dist/index.js verdict --diff-file change.diff --json
```

### PreToolUse (advance warning, optional)

The Stop hook is the recommended gate because the change is complete and the sim has real code
to execute. If you also want a *heads-up* before Claude edits sensitive files, a `PreToolUse`
hook matching `Edit|Write` can deny writes to protected paths — but note the trust-layer
verdict needs an applied change to run the sim, so keep policy enforcement on the Stop hook and
use PreToolUse only for fast path-based guards.

## How it decides

`keel verdict` composes existing Keel facts and evaluates them against your policy:

| Fact | Source | Default policy | Configurable via |
| --- | --- | --- | --- |
| Executed sim pass/fail | `preflight` (sandboxed test run) | block on fail | `requireSimPass` |
| Blast radius | `get_impact` | (off) | `maxBlastRadius` |
| Uncovered changed files | `select_tests` | (off) | `forbidUncoveredChanges` |
| Skipped tests at the cap | sim budget | warn | `forbidTruncatedSim` |
| Protected paths touched | the diff | (off) | `protectedPaths` |
| Affected recorded decisions | decision index | (off) | `requireDecisionReview` |

See [`docs/architecture.md`](../docs/architecture.md) (Trust layer) for the policy schema and
`keel.policy.json` fields.
