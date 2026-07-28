# Recipe: Keel as a GitHub check on every PR

Post Keel's **pass | warn | block** verdict as a native GitHub check run, so each PR shows a
green ✓ / neutral / red ✗ next to the exact reasons — blast radius, the *executed* covering
tests, coverage gaps, and any recorded decisions the change touches. It's the same
deterministic trust layer as the `verdict` MCP tool and the Claude Code hook; here the sink is
GitHub instead of the terminal.

## How the verdict sees a PR

Keel simulates a change by **applying a diff onto a baseline and running the covering tests**.
For a PR, the baseline is the *base branch* and the change is what the PR adds. So the workflow
checks out the base commit, feeds Keel the PR's forward diff, and attaches the result to the PR
head commit with `--sha`:

```
git diff -M <base_sha> <head_sha> > pr.diff   # the PR's forward changes
git checkout <base_sha>                        # baseline = base; graph + tests are the base's
keel verdict --diff-file pr.diff --sha <head_sha> --github-check
```

Running against a clean checkout of the PR head instead would show *no* changes (they're
already committed) and the verdict would be a meaningless pass — the base-checkout is what makes
the sim actually exercise the PR.

## Workflow

Add `.github/workflows/keel.yml` to the repo you want gated. It needs `checks: write` so the
built-in `GITHUB_TOKEN` can publish the check.

```yaml
name: keel
on: pull_request

permissions:
  contents: read
  checks: write        # required for keel to publish the check run

jobs:
  verdict:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # need both the base and head commits present

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      # Install project deps so the sim can run the covering tests.
      - run: npm ci

      # Make the `keel` CLI available. Until Keel is published, build it from a checkout;
      # swap this for `npm i -g keel` once it's on npm.
      - name: Build keel
        run: |
          git clone --depth 1 https://github.com/<you>/keel /tmp/keel
          npm --prefix /tmp/keel ci
          npm --prefix /tmp/keel run build

      - name: Keel verdict
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          BASE: ${{ github.event.pull_request.base.sha }}
          HEAD: ${{ github.event.pull_request.head.sha }}
        run: |
          git diff -M "$BASE" "$HEAD" > /tmp/pr.diff
          git checkout --quiet "$BASE"
          KEEL_REPO="$PWD" node /tmp/keel/dist/index.js verdict \
            --diff-file /tmp/pr.diff \
            --sha "$HEAD" \
            --github-check
```

That's it. Each PR gets a **keel/verdict** check:

- **block** → the check fails (red ✗) and the step exits `2`, failing the job.
- **warn** → the check is neutral; the step exits `0` (warnings don't fail CI on their own).
- **pass** → the check is green; exit `0`.

The check's summary carries the blast radius and sim result; its details list every rule with
the exact fact behind it (e.g. `✗ requireSimPass — 2 test(s) failed: renders header (Header.test.tsx)`).

## Making it required

Two independent gates — use either or both:

- **The check conclusion.** In *Settings → Branches → Branch protection*, require the
  `keel/verdict` status check. GitHub then blocks merge on a block (and, if you choose, on a
  neutral warn).
- **The job exit code.** The step already exits `2` on block, so the workflow fails without any
  branch-protection setup.

## Flags

`--github-check` composes with the rest of `keel verdict`:

| Flag | Purpose |
| --- | --- |
| `--sha SHA` | commit the check attaches to — the PR head (falls back to `GITHUB_SHA`, then `git HEAD`) |
| `--repo owner/repo` | publish to a specific repo (default: the `origin` remote) |
| `--json` | also print the full verdict JSON to stdout (to archive as a build artifact) |
| `--max-tests`, `--max-seconds` | the sim budget caps, same as `preflight` |

Publishing failures (no token, missing `checks:write`, an unpushed SHA) are reported on stderr
and make the step exit `1` — unless the verdict is already a block, which stays `2`.

## Related

- [claude-code-hook.md](claude-code-hook.md) — the same verdict as a Claude Code Stop hook.
- [`docs/architecture.md`](../docs/architecture.md) (Trust layer) — the policy schema.
