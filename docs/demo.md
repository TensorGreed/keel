# Keel demo: three scenes on a real repo

This is the demo from [concept.md §9](concept.md) run for real against
[honojs/hono](https://github.com/honojs/hono) — a well-known TypeScript web framework. Three
scenes: **what depends on this?**, **what breaks if I change it?**, and **is this change safe?**
Every number and every line of output below was captured from an actual run (hono `224d2f5`,
v4.12.32, 381 source files; timings from a warm laptop). Reproduce it in ~3 minutes.

## Setup (~1 min)

```bash
# 1. Get the target repo and its deps (hono's tests run on vitest).
git clone --depth 1 https://github.com/honojs/hono.git
cd hono
npm install

# 2. Point Keel at it. If you installed Keel globally or via npx, `keel init`
#    writes .mcp.json here; otherwise run keel with KEEL_REPO=. (as below).
npx -y @tensorgreed/keel init          # registers keel in hono/.mcp.json
```

Now open Claude Code in the `hono` directory. Scenes 1–2 are Keel MCP tools your agent calls;
scene 3 is a shell command (also what a CI check or Git hook runs).

---

## Scene 1 — "What depends on the Context object?"  (~0.3s)

`Context` (`src/context.ts`) is the object every hono handler receives. Ask your agent:

> *What's the blast radius of changing `src/context.ts`?*

Keel calls `get_dependencies` and answers from the graph — no LLM guessing, just parsed imports:

```jsonc
{
  "file": "src/context.ts",
  "blastRadius": 196,          // files that transitively depend on this one
  "filesScanned": 381,
  "dependents": [ /* 70 direct importers */
    "src/hono-base.ts",
    "src/request.ts",
    "src/middleware/serve-static/index.ts",
    "src/adapter/bun/websocket.ts",
    "..."
  ],
  "dependencies": [ "src/request.ts", "src/router.ts", "src/utils/html.ts", "..." ]
}
```

**196 files** ride on `Context`. That's the number an agent needs before it "just refactors" it.
First run builds the graph in **~0.75s** cold; it's cached on git HEAD, so repeat queries are
**~0.3s**.

---

## Scene 2 — "What actually breaks if I get cookie parsing wrong?"  (~1.8s)

Cookies are `;`-separated. Suppose an agent (or a tired human) introduces a one-character bug —
splitting on `,` instead:

```diff
--- a/src/utils/cookie.ts
+++ b/src/utils/cookie.ts
@@ -111,7 +111,7 @@ export const parse = (cookie: string, name?: string): Cookie => {
     // Fast-path: return immediately if the demanded-key is not in the cookie string
     return {}
   }
-  const pairs = cookie.split(';')
+  const pairs = cookie.split(',')
   const parsedCookie: Cookie = Object.create(null)
```

Ask your agent to check it before proposing the change:

> *Run preflight on this cookie.ts change.*

Keel maps the diff to its impacted subgraph, selects the covering tests, applies the diff in an
isolated git worktree, and **runs them** — returning proof, not a prediction:

```jsonc
{
  "impacted": 52,             // files reachable from the change
  "testsSelected": 32,        // test files that actually cover them
  "uncoveredChanges": 0,
  "budget": { "maxTests": 50, "maxSeconds": 120, "truncated": false },
  "executed": {
    "status": "failed",
    "passed": 1089,
    "failed": 43,
    "durationMs": 1805
  },
  "failures": [
    {
      "file": "src/utils/cookie.test.ts",
      "test": "Parse cookie Should parse cookies",
      "message": "AssertionError: expected undefined to be 'choco'",
      "graphPath": ["src/utils/cookie.test.ts", "src/utils/cookie.ts"]
    },
    {
      "file": "runtime-tests/lambda/index.test.ts",
      "test": "AWS Lambda Adapter … return 200 if cookies match",
      "message": "AssertionError: expected 'Invalid Cookies' to be 'Valid Cookies'",
      "graphPath": [
        "runtime-tests/lambda/index.test.ts",
        "src/helper/cookie/index.ts",
        "src/utils/cookie.ts"
      ]
    }
  ]
}
```

**43 real failures across 6 test files, in 1.8 seconds** — from the direct unit test to the AWS
Lambda adapter three hops away. Each failure carries the `graphPath` from the failing test back
to the one line that broke it, so the fix is obvious. No dashboard, no "this might affect 52
files" — executed pass/fail.

---

## Scene 3 — "Is this change safe to merge?"  (~2s)

The same facts, turned into a machine-checkable verdict — this one is a plain shell command, so
it drops straight into CI or a Git hook. Save the diff above as `cookie.diff`, then:

```console
$ KEEL_REPO=. npx -y @tensorgreed/keel verdict --diff-file cookie.diff
[keel] verdict: BLOCK (policy: default)
[keel] blast radius 52, sim failed (1089 passed, 43 failed)
[keel]   ✗ requireSimPass: 43 test(s) failed: Parse cookie Should parse cookies
        (src/utils/cookie.test.ts), AWS Lambda Adapter for Hono … if cookies match
        (runtime-tests/lambda/index.test.ts), …
$ echo $?
2
```

Exit code **2** = block. hono ships no `keel.policy.json`, so Keel applies its conservative
default (the executed sim must pass). Add a policy to gate on blast radius, coverage, protected
paths, or affected decisions — see [../recipes/github-check.md](../recipes/github-check.md) to
post this as a GitHub check on every PR, and [../recipes/claude-code-hook.md](../recipes/claude-code-hook.md)
to make an agent fix the failures before it's allowed to finish.

---

## What just happened

| Scene | Tool | Result | Time |
| --- | --- | --- | --- |
| 1. What depends on this? | `get_dependencies` | blast radius **196** / 381 files | ~0.75s cold, ~0.3s warm |
| 2. What breaks if I change it? | `preflight` | **43 executed failures** across 6 files, with graph paths | ~1.8s |
| 3. Is it safe to merge? | `keel verdict` | **BLOCK**, exit 2, naming the failing tests | ~2s |

Just a git clone and the tools a developer already uses — suddenly knowing things they couldn't
know before. Every claim backed by an executed test; nothing here called a flagship model.
