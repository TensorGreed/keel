# Roadmap

Sequenced by dependency: substrate → simulator → memory → trust. Each phase ends in a
demo. Work top-to-bottom; keep checkboxes current (same commit as the feature).

## Phase 0 — Substrate skeleton

Goal: an MCP server Claude Code can register, answering graph and history questions
about any TS/JS repo. **Demo:** graph-backed answers on a fresh public repo.

- [x] Repo scaffold: TS strict, ESM, vitest, MCP stdio server
- [x] `get_dependencies` v0: file-level import graph via TS compiler API
- [x] `get_history` v0: git log for a path via child_process
- [x] Resolve tsconfig path aliases + monorepo workspaces in the graph
- [x] Symbol-level dependencies: which exports of a file each dependent actually uses
- [x] Event log v1: SQLite persistence via `node:sqlite`, commits ingested on startup
- [x] `keel init` UX: one command that registers the server in `.mcp.json`
- [x] Incremental graph cache keyed by git HEAD (rebuildable from clean clone)

## Phase 1 — Flight simulator MVP

Goal: `preflight(diff)` returns **executed** results, single repo, TS/JS.
**Demo:** "what happens if I rename this field?" answered with real failures in <2 min.

- [x] Diff → impacted-subgraph mapping (files v0, symbols v1)
- [x] Test selection: map test files to the source files they cover (imports v0)
- [x] Sandbox runner: apply diff in a temp git worktree, run selected tests (vitest/jest)
- [x] Budget caps: max tests, max wall time; caps always reported in output
- [x] `preflight` MCP tool: { impacted, testsSelected, executed, failures[] }
- [x] Failure report: trace + the graph path from change to failure

## Phase 2 — Team memory

Goal: `why(path)` answers with mined decision records and receipts.
**Demo:** "why is this like this?" → actual PR thread, author, incident links.

- [x] GitHub connector: backfill PRs + review threads into the event log
- [x] Decision miner: local model (Ollama) or batch Haiku; prompt + eval fixture set
- [x] Decision records linked to graph nodes; embeddings for retrieval (local model)
- [x] `why` MCP tool with source links; pin/correct mechanism (human override wins)
- [x] Incremental mining on new PRs (cost target: <$0.25/day for 50 PRs)

## Phase 3 — Trust layer

Goal: policy verdicts that let agents take bigger changes safely.
**Demo:** an agent completes a cross-cutting refactor gated by Keel and auto-merges.

- [x] Verdict object: blast radius, sim status, decision conflicts
- [x] Policy file format (`keel.policy.json`) + evaluator (pure, no model calls)
- [x] `verdict` MCP tool; GitHub check integration (`keel verdict --github-check`, recipes/github-check.md)
- [x] Claude Code hook recipe: `keel verdict` as a Stop hook (recipes/claude-code-hook.md)

## Phase 4 — Compose: more value from the substrate

Goal: higher-order tools that compose the graph, sim, and decision index into answers a
caller would otherwise assemble by hand. **Demo:** "brief me on this task" returns the files,
tests, decisions, and risks for a change before a line is written.

- [x] Context briefing tool: one call maps a task to its candidate files, blast radius, tests,
      decisions, and risks (compose get_dependencies + why + select_tests, ranked)
- [x] Architectural import rules in policy + verdict: forbidden `from`→`to` edges block a
      change that introduces or retains them; repo-wide violations reported for adoption
      (`keel.policy.json` forbiddenImports, `keel report --arch`)
- [x] Risk hotspot report: rank files by churn × blast radius × coverage gap, so review
      attention goes where a change is most likely to bite (`keel report --hotspots`; also a
      risk flag in the context tool)
- [x] Reviewer / ownership signal: recency-weighted authorship per file from the event log,
      surfaced as the `suggest_reviewers` tool, per-candidate owners in `context`, and a
      `warnOnForeignCode` verdict signal (bots excluded)

## Phase 5 — Widen

Goal: the same substrate over more languages, more sources, and more than one repo.
**Demo:** graph + sim answers on a Python service, with decisions mined from its ADRs.

- [x] Python support: tree-sitter (web-tree-sitter WASM) graph extraction alongside the TS
      compiler API, behind a LanguageScanner seam
  - [x] Language seam: LanguageScanner interface; the TS builder moved behind it (pure refactor)
  - [x] Python scanner: imports (abs/relative/star), resolution (packages, src/ layouts by
        config OR convention — the importing file's package tree, then src/<pkg>, then repo
        root, namespace packages last), exports (def/class/assign, __all__); zero-build WASM grammar
  - [x] Multi-language cache + mixed TS+Python repos (one graph, no cross-language edges yet);
        get_dependencies/get_impact/select_tests work on Python
  - [x] pytest sandbox runner: preflight EXECUTES Python (reuses the repo venv, PYTHONPATH to the
        worktree, JUnit parsed by the `keel ci` parser); pytest absent → `runner-unavailable`
        naming the interpreter, never a crash
- [x] Go support: tree-sitter-go (WASM, zero-build) graph extraction + `go test` execution,
      behind the LanguageScanner seam
  - [x] Go scanner: imports target PACKAGES (dirs) → an edge to every non-test .go file of the
        package (one compilation unit); single/factored imports, aliases, dot (→ "*") and blank
        (side-effect) imports; exports = capitalized top-level funcs/types/vars/consts, methods
        attributed to their receiver type; resolution via go.mod module path + go.work
        workspaces; vendor/ and testdata/ excluded
  - [x] Go test runner: select _test.go (same-package + black-box) via the dependents walk, run
        `go test -json` per package in the sandbox worktree; a compile error IS the executed
        result (surfaced as a failure); go absent → `runner-unavailable`
- [x] Java support: tree-sitter-java (WASM, zero-build) graph extraction + `mvn`/`gradle`
      execution, behind the LanguageScanner seam
  - [x] Java scanner: package declaration; single-type / on-demand (`a.b.*` → "*") / static
        imports (member → its type); exports = public top-level types (class/interface/enum/
        record/annotation); resolution maps package dirs under discovered source roots
        (Maven/Gradle src/main/java, src/test/java; multi-module via pom `<modules>` +
        settings.gradle `include(...)`, regex-level, no XML/DSL dep). CRITICAL: same-package
        files are one unit (mutual adjacency across source roots) — types reference each other
        with no import, so import-only edges would miss it
  - [x] Java test runner: select test-source-root + *Test.java/*Tests.java/Test*.java via the
        dependents walk; prefer ./mvnw · ./gradlew over global mvn · gradle; run only the selected
        classes; Surefire/Gradle JUnit XML via the existing parser; compile error IS the executed
        result; no build tool → runner-unavailable; toolchain/env failure → environment-error
  - [x] Spring DI edges: a Java graph-enrichment pass adding the runtime wiring imports miss —
        beans (stereotypes), injection points (constructor/@Autowired/Lombok/@Bean-method params),
        and interface→implementation resolution, so an injected interface edges to every impl and a
        @Bean-produced type edges to its @Configuration; `@Qualifier` narrows to the named bean
        (default/stereotype/@Qualifier name), conservatively keeping all when it matches nothing;
        cross-file, so a Java change forces a full rebuild (graph format v3)
- [x] CI connector + flaky-test detection: ingest CI runs, flag tests that fail
      non-deterministically so the sim can discount them
  - [x] CI connector: `keel ci` ingests JUnit reports into ci_run events (universal, no deps,
        idempotent; a flipped re-run on one commit is a distinct observation)
  - [x] Flaky detection: a test that both passed and failed on the same commit (`flaky_tests`
        tool); the verdict discounts a flaky-only sim failure to a warn instead of blocking
- [x] ADR ingestion into the decision index: Markdown ADRs as first-class decision records.
      `keel ingest` gains a local source (docs/adr/**, docs/decisions/**) — MADR-parsed (title/
      status/context/decision), stored as origin "adr" (ranked above mined, below `keel decision
      add`), linked to graph nodes by repo-relative paths in the body (unlinked ones still surface
      via question search). Idempotent by path + content hash; edits re-ingest. No model calls in
      ingestion; embedding stays best-effort
- [x] Cross-repo workspaces: one graph spanning multiple repos/services. `keel.workspace.json`
      lists member repos; the graph loads each member's own graph, namespaces files as `name::path`,
      and adds cross-repo edges — a member's external (unresolved-in-repo) import matched to what a
      sibling publishes: TS/JS by package.json name→source entry, Python/Go by reusing the sibling's
      resolver. Blast radius crosses repos; queried via `keel workspace [impact|deps]`. Execution,
      decisions, and MCP tools stay single-repo this pass (Java cross-repo deferred)

## Phase 6 — `keel upgrade`: dependency upgrades with proof

Goal: turn "bump this dependency" from a leap of faith into a scoped, executed, and eventually
repaired change. This is the substrate's first *application*: the graph knows who imports the
package, the simulator proves what the bump breaks, memory recalls why the pin exists, and the
trust layer decides whether it can be automated. **Demo:** point keel at a real repo, name a
dependency, and get back the exact call sites that break — executed, not predicted.

Sequenced so each phase is useful alone, and so nothing writes code until keel can prove what's
broken.

- [x] **Phase 0 — scope + break discovery + report (REPORT-ONLY).** `keel upgrade <pkg>@<version>`
      and the `upgrade_scope` MCP tool. Scope: every file importing the package (from the graph's
      retained external specifiers), the union blast radius, the covering tests, and the share of
      the repo reached. Discovery: in a sandbox worktree, apply *only* the version bump and run the
      covering tests, plus the install-time signals (peer-dep conflicts, engine mismatches) that are
      breaks in their own right. Report: surface, executed failures with traces and graph paths back
      to the import sites, known-flaky failures discounted **and labelled as such**, uncovered
      surface, and a verdict for the bare bump. Attempts no repairs, and says so.
- [x] **Phase 1 — agent-driven repair loop.** `keel upgrade --repair` and the `upgrade_repair` MCP
      tool hand the caller's agent ONE failure at a time with everything needed to fix it — the
      failing test and trace, the import site and its source, which of the package's exports that
      file actually uses, and the package's own account of the change (its CHANGELOG sliced between
      the two versions, plus a real diff of its manifest and entry file). The agent writes the patch;
      keel re-runs the sim on it — now also running the tests covering whatever the patch touched —
      and iterates until `green` or `exhausted`. The loop is INVERTED and STATELESS: keel can't write
      the fix (principle 1), so it is the loop's other half, and the agent holds the accumulated
      patch rather than keel holding a session.
- [x] **Phase 2 — memory-informed repair.** Before anything is proposed, keel consults the decision
      index: decisions linked through the graph to the files that import the package, unioned with
      decisions that name the package, each with its receipt. A pin with a recorded reason ("held
      back at 4.x, see #812 — the 5.x codec breaks our uploads") is listed FIRST in next-steps and
      attached to every repair task, so an agent sees it before it writes a line. Keel surfaces it;
      it does not rule on whether the pin forbids the upgrade (the trust layer judges it under the
      existing `requireDecisionReview` rule, like any other change). And the flywheel: a repair that
      reaches green is written back to the event log as an `upgrade_repair` event, so the next
      upgrade of that package starts from the migration the first one worked out.
- [x] **Phase 3 — batch + policy.** `keel upgrade --batch` and the `upgrade_batch` MCP tool. Every
      target is scoped from the graph first (cheap) and ranked by a risk score — reach, unproven
      reach, version jump, and whether a recorded decision mentions it — then executed SAFEST FIRST
      against one shared budget, so a truncated pass has landed the most mergeable upgrades. What it
      never reached comes back as `not-run`, never as silence. `keel.policy.json` gains an
      `upgrades` block: `autoMergeOnGreen`, `alwaysReview` globs, and `pinned` packages (a reason is
      required — an unexplained pin is one the next person deletes). Outcomes: `pinned` (not
      executed), `auto-merge`, `needs-review`, `blocked`, `not-run`. Each executed entry carries a PR
      proposal — branch, title, a body containing the executed proof, an applicable manifest patch,
      and the commands to open it. Keel composes those and does NOT push branches or open PRs:
      pushing under someone's credentials isn't keel's to assume.

## Phase 7 — Team & ambient

Goal: the substrate stops being one person's local setup. Memory becomes a reviewable artifact the
whole team and every agent shares, and keel is warm before anyone asks it anything.
**Demo:** clone a repo, open Claude Code, and the agent already knows why the code is the way it is —
no mining, no model, no waiting.

- [x] **Decisions as code.** `keel mine`, `keel ingest`, and `keel decision add/reject` maintain
      `.keel-decisions.jsonl` at the repo root — a committed, reviewable, one-record-per-line export
      of the decision index (deterministic ordering and stable formatting, so the diff is the
      change). Keel loads it into the local index on startup when records are missing: one person
      mines, commits the file, and every clone thereafter has the memory with no model call and no
      network. Local human records win over the file, the file wins over nothing, and a suppression
      in the file suppresses everywhere. Embeddings stay local and lazy — vectors don't belong in git.
- [x] **Ambient warmth (`keel watch`).** Measured first, on the 24k-file synthetic repo: with a warm
      HEAD-keyed cache a cold start loads the graph in **~200ms**, so a resident daemon would save a
      fifth of a second on a repo far larger than most — not worth its lifecycle, staleness and IPC.
      **No daemon.** What the numbers did show is that a file ADD forces a full rebuild (2.4s) which
      lands inside the next tool call, and that is what shipped: a debounced `fs.watch` pre-warm (no
      new deps) that moves the rebuild off the critical path — measured 2321ms → **46ms** for the
      next tool call after an agent adds a file. The MCP server runs it automatically
      (`KEEL_NO_WATCH=1` to disable); `keel watch` runs it in the foreground outside a session, and
      `keel doctor` reports whether it's supported and enabled.

## Phase 8 — Evidence

Goal: stop asserting that keel works and start measuring it. Every claim keel makes is falsifiable —
`select_tests` says these 12 of 840 matter, `preflight` says these 3 fail, `verdict` says pass — and
CI, commits and reverts all answer. **Demo:** a number anyone can reproduce on their own repo.

- [x] **Selection evidence by fault injection** (`keel evidence`). Break a covered source file, run
      the WHOLE suite to find out what really fails, and check whether keel's selection contained it.
      Reports the escape rate (a failing test keel didn't select — the number that matters) and
      selectivity (the share of the suite skipped — the benefit, worth nothing until escapes are
      zero). Deterministic by seed, runs in a throwaway worktree, needs no users and no accumulated
      history. On keel itself: **0 escapes in 11 measured trials, 66.7% selectivity.**
- [ ] **Claim instrumentation.** A `tool_call` event recording what each MCP tool claimed — which
      tests selected, which failures predicted, which verdict — so real usage can later be scored
      against what actually happened.
- [ ] **`keel evidence --backtest`.** Join those recorded claims to ingested CI runs: preflight
      precision/recall against real failures, verdict calibration against what later broke, and
      compute avoided measured from the suite's own recorded per-test timings.

## Later

Team deployment, policy sharing, incident + Jira connectors, service-level graphs.
