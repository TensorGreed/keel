# Concept Doc — A Development Intelligence Layer

**Working name:** Keel *(the structural spine a ship is built around — rename freely)*
**Author:** Anurag Jain, drafted with Claude
**Date:** July 27, 2026
**Status:** Draft v1 — for discussion

---

## 1. One-line pitch

> **Your codebase, with memory and foresight.** Keel is a persistent intelligence layer that knows why your system is the way it is, can prove what happens if you change it, and uses both to let you safely turn up the autonomy of your coding agents.

Internally, it is architected like an operating system for engineering knowledge. Externally, we never say "AI OS" — we sell the three consequences.

## 2. The problem

The bottleneck in software development has shifted. In 2026, coding agents (Claude Code, Copilot, Cursor) can write almost any code you ask for. What they cannot do is know:

- **Why** the system is the way it is — the decision history lives in dead PR threads, departed employees' heads, and stale docs.
- **What happens** if they change something — cross-service, cross-schema, cross-repo consequences are invisible until CI or production finds them.
- **Whether they can be trusted** with a given change — so teams keep agents on a short leash, using perhaps 20% of their capability.

Every existing "context layer" product answers *what is in the codebase*. Almost nothing answers *why it's there* or *what happens if you touch it*. Those two questions are what interrupt senior engineers all day, and what block agent autonomy.

## 3. The product: three pillars, one brain

The three pillars are one product because each makes the others possible. Memory explains why. The simulator proves what happens. Trust is what emerges when you have both — it is not a feature, it is the product of the other two.

### Pillar 1 — Team Memory ("git blame for intent")

A queryable decision history mined from PRs, review threads, commits, ADRs, tickets, and incidents, linked to the code it explains.

*The moment it sells:* a new engineer (or an agent) asks *"why does the billing service talk to Redis directly instead of going through the cache layer?"* and gets the actual 2024 PR discussion, the incident that caused the decision, and who made it. The team's memory outlives the people who leave.

### Pillar 2 — Flight Simulator ("we don't predict, we go find out")

Everyone else does static analysis and produces mushy "this might affect…" warnings that developers learn to ignore. Keel spins up ephemeral sandboxes, applies your proposed change, runs the dependent modules' tests and contract checks, and returns: **"here are the three actual failures this causes, with stack traces."**

*The moment it sells:* before writing a line, you ask *"what happens if I rename this field?"* and get a concrete, executed answer in minutes. A weather forecast vs. a time machine.

### Pillar 3 — Trust Layer ("the reason you can turn agent autonomy up")

A policy engine over the first two pillars. For any proposed change — human or agent — it computes a verdict: blast radius contained? affected tests pass in simulation? any architectural decision violated? Any team can then encode policies like *"agents may auto-merge changes with green simulation, zero cross-service impact, and no ADR conflicts."*

*The moment it sells:* a team that let agents touch only leaf code now lets them do cross-cutting refactors, because every change arrives pre-verified with receipts. We become the reason the AI tools they already bought get 10× more useful. This repositions Copilot/Claude Code from competitors into distribution.

## 4. Architecture: the shared substrate

Build the substrate once; the three pillars are read/write clients of it.

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
│  ┌──────────────┐ ┌──────────────┐ ┌────────────────┐  │
│  │  EVENT LOG   │ │ SYSTEM GRAPH │ │ DECISION INDEX │  │
│  │ commits, PRs,│ │ code, APIs,  │ │ mined "why":   │  │
│  │ CI runs,     │ │ schemas,     │ │ ADRs, PR       │  │
│  │ incidents,   │ │ services,    │ │ threads,       │  │
│  │ deploys      │ │ dependencies │ │ incidents      │  │
│  └──────────────┘ └──────────────┘ └────────────────┘  │
└────────────────────────────────────────────────────────┘
```

- **Event log** — every commit, PR, review comment, CI run, deploy, incident, normalized into one timeline. (SQLite/Postgres + connectors.)
- **System graph** — code symbols, call/import edges, API contracts, DB schemas, service boundaries, continuously rebuilt from the repo. (tree-sitter + language-native tooling; graph store.)
- **Decision index** — decision records extracted from PR discussions, ADRs, tickets, linked to the graph nodes they explain, with embeddings for retrieval.

The flywheel: every simulation result becomes an event; every incident enriches memory; every memory entry sharpens what the simulator checks.

**Delivery model — this is a load-bearing decision.** Keel ships as an MCP server, not an editor, bot, or platform. Consequences:

1. Day-one value inside tools developers already use; we replace nothing.
2. No five-integration cold start: repo-only value first, Jira/CI/deploy connectors as progressive enrichment.
3. The expensive reasoning happens in the *caller's* model on the *caller's* subscription (see §5).

## 5. Cost architecture — why this is cheap to run

Design principle: **flagship tokens only at the moment of interaction — and even then, on someone else's meter.** The pipeline itself is mostly not LLM work at all.

| Layer | Workload | Engine | Marginal cost |
|---|---|---|---|
| System graph | parsing, dependency edges | tree-sitter / static analysis | CPU only — **$0 tokens** |
| Event log | ingestion, normalization | plain ETL | **$0 tokens** |
| Flight simulator | sandboxed test execution | containers / CI runners | compute, not tokens |
| Decision mining (backfill + incremental) | summarize PR threads → decision records | **small model**: local (Ollama) or Haiku-class via Batch API | see math below |
| Embeddings | retrieval index | local embedding model | ~$0 |
| Query-time reasoning | "why?" / "what breaks?" answers | **the caller's own agent** (Claude Code, on the user's plan) | **$0 to us** |

**The MCP trick:** when Claude Code calls Keel, Keel returns compact structured facts (decision records, impact lists, sim results). The flagship model doing the reasoning is the user's own session, already paid for. Keel's server never needs to invoke a flagship model in the hot path.

**Decision-mining math** (the only real token cost). At July 2026 rates, Haiku 4.5 is $1/M input, $5/M output, and the Batch API halves both. Backfilling 10,000 PRs at ~4K tokens in / 300 out each ≈ 40M in + 3M out → **~$27 one-time** via batch Haiku. Incremental load (50 PRs/day) is under **$0.15/day**. Even a 100K-PR monorepo backfill is ~$270 — once, ever.

**Can we rely on Ollama/local models? Yes, for exactly this layer.** The mining workload is extraction and summarization — the workload 2026-era local models (Qwen3-Coder-class, 14–70B) handle well. Recommended posture:

- **Local-first by default** for decision mining and embeddings — $0 marginal cost, and a genuine privacy selling point ("your PR history never leaves your machine").
- **Cloud batch Haiku as the quality/speed escape hatch** — for large backfills (local throughput is the real constraint, not quality) or for high-stakes threads where nuance matters.
- **Never build anything that requires flagship-model calls on the server side.** If a feature needs Opus/Fable-class reasoning, deliver it as context to the caller's agent instead.

Bottom line: infrastructure (a VM, storage, sandbox compute) dominates the bill; model cost is a rounding error. Operating cost is **not** a risk for this product — *if* we hold the line on the design principle above.

## 6. Roadmap — sequenced by dependency, not preference

Built solo with Claude Code; each phase ends in something demoable.

**Phase 0 — Substrate skeleton (week 1–2).**
Repo connector, event log schema, system graph builder for one language (TypeScript or Python first) via tree-sitter. MCP server scaffold with two tools: `get_dependencies(symbol)`, `get_history(path)`.
*Demo: Claude Code asks Keel about a repo and gets graph-backed answers.*

**Phase 1 — Flight simulator MVP (week 3–6).**
Given a diff (or a described change), compute the impacted subgraph, select the tests that matter, run them in a sandbox against the applied change, return failures with traces. Single-repo, single-language.
*Demo: the two-minute wow — "what happens if I rename this field?" answered with executed proof, from a fresh public repo, no integrations needed.*

**Phase 2 — Team memory (week 7–10).**
GitHub history backfill → decision mining (local model / batch Haiku) → decision index linked to graph nodes. MCP tool: `why(symbol_or_path)`.
*Demo: "why is this like this?" answered with the actual PR thread and author.*

**Phase 3 — Trust layer (week 11–14).**
Policy engine over sim results + memory: per-change verdicts (blast radius, sim status, ADR conflicts). A `preflight(diff)` MCP tool agents call before proposing changes; optional GitHub check on PRs.
*Demo: an agent completes a cross-cutting refactor gated by Keel and auto-merges it.*

**Later:** more languages, cross-repo/cross-service graphs, CI/Jira/incident connectors, team deployment, policy marketplace.

## 7. Competitive positioning

| Who | What they own | Why we're different |
|---|---|---|
| Sourcegraph, code-graph MCP servers | "what is in the codebase" (search, graph) | We commoditize this layer ourselves (tree-sitter) and compete above it: *why* and *what happens* |
| Unblocked-style Q&A tools | codebase Q&A for humans | We serve agents via MCP, link answers to a live graph, and add executed verification |
| Static impact-analysis tools | single-repo, single-language warnings | We *execute* the hypothetical change — proof, not prediction |
| GitHub/Anthropic platforms | the agents themselves | We are the tool their agents call — distribution, not competition. Risk: platform subsumption (see §8) |

**Moat over time:** the decision index and event log are accumulated, team-specific data that cannot be re-derived from a fresh clone. Every week of usage widens the gap between Keel-on-your-repo and any competitor starting cold.

## 8. Risks — honest list

1. **Platform subsumption.** GitHub or Anthropic builds enough of this natively. Mitigation: move fast on the two layers (decision memory, executed simulation) that require accumulated data and real engineering, not just model quality.
2. **Cross-language/cross-service edge cases.** Where static-analysis companies quietly drown. Mitigation: one language, one repo, done excellently, before any breadth.
3. **Simulation compute blowup.** Can't run everything. Mitigation: the graph exists precisely to scope test selection; cap sandbox budgets per query.
4. **Mining quality with small models.** Nuanced "why" extraction may degrade. Mitigation: hybrid local/batch-Haiku posture; humans can pin/correct decision records.
5. **Solo-founder surface area.** Three pillars is a lot. Mitigation: the roadmap's phase gates — each phase is a shippable product on its own; stop-and-sell is possible after Phase 1 or 2.

## 9. What the first public demo looks like

A 3-minute screen recording: clone a well-known open-source repo, point Keel at it, open Claude Code.

1. *"What happens if I rename `user_id` to `account_id` on the `Session` model?"* → Keel returns the impacted subgraph and **executed** test failures, in under two minutes, from a cold start.
2. *"Why is session storage in Redis instead of the DB?"* → Keel returns the mined decision record with the original PR link.
3. Ask Claude Code to make the change anyway → it calls `preflight`, gets a scoped test list, fixes the failures Keel found, and opens a PR that passes CI first try.

No dashboard. No new UI. Just the tools a developer already uses, suddenly knowing things they couldn't know before.

---

*Next step: pick the first target language + a real repo to develop against, and start Phase 0 in Claude Code.*
