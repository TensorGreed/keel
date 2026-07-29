import { describe, expect, it } from "vitest";
import type { KeelEvent } from "../src/events/store.js";
import { EmbeddingError, type EmbeddingModel } from "../src/retrieval/embed.js";
import {
  buildHookOutput,
  matchPromptDecisions,
  parseHookPrompt,
  renderAdditionalContext,
  type DecisionSource,
} from "../src/retrieval/prompt-context.js";

// keel prompt-context surfaces recorded decisions relevant to a user's prompt, for Claude Code's
// UserPromptSubmit hook. It must be fast, silent when it has nothing, and never throw — so these
// tests drive the core with a fake store + fake embedder (no SQLite, no network).

function decision(
  id: string,
  summary: string,
  rationale: string,
  files: string[] = [],
  extra: Record<string, unknown> = {},
): KeelEvent {
  return {
    kind: "decision",
    externalId: id,
    occurredAt: "2021-01-01T00:00:00Z",
    title: summary,
    payload: { origin: "human", summary, rationale, alternatives: [], confidence: "high", ...extra },
    files,
  };
}

class FakeStore implements DecisionSource {
  constructor(
    private readonly decisions: KeelEvent[],
    private readonly embeddings: Map<string, Float32Array> = new Map(),
    private readonly suppressed: Set<string> = new Set(),
  ) {}
  async byKind(): Promise<KeelEvent[]> {
    return this.decisions;
  }
  embeddingsByKind(): Map<string, Float32Array> {
    return this.embeddings;
  }
  suppressedDecisions(): Set<string> {
    return this.suppressed;
  }
}

class FakeEmbed implements EmbeddingModel {
  readonly name = "fake";
  constructor(private readonly impl: (texts: string[]) => Promise<Float32Array[]>) {}
  embed(texts: string[]): Promise<Float32Array[]> {
    return this.impl(texts);
  }
}

describe("matchPromptDecisions — keyword", () => {
  it("surfaces a decision on a distinctive term overlap", async () => {
    const store = new FakeStore([
      decision("d:nonce", "Derive a per-message nonce for the cipher", "reusing a static nonce leaked plaintext", ["src/cipher.ts"]),
      decision("d:99", "Prefer flat config files", "nested config was hard to override", ["src/config.ts"]),
    ]);
    const hits = await matchPromptDecisions(store, "why do we derive a fresh nonce instead of reusing one", {
      embedModel: null,
    });
    expect(hits.map((h) => h.id)).toEqual(["d:nonce"]);
    expect(hits[0]!.files).toEqual(["src/cipher.ts"]);
  });

  it("does not count a generic-term overlap as a hit", async () => {
    // The prompt and the decision share "run" and "sample", but those are generic repo vocabulary;
    // the distinctive term ("snowflake") isn't in the decision, so it must stay silent.
    const store = new FakeStore([
      decision("d:fpe", "Run the FPE sample cipher", "the sample runs the FPE routine"),
    ]);
    const hits = await matchPromptDecisions(store, "how do I run the Snowflake sample", { embedModel: null });
    expect(hits).toEqual([]);
  });

  it("returns nothing when no decision relates to the prompt (silent by default)", async () => {
    const store = new FakeStore([
      decision("d:99", "Prefer flat config files", "nested config was hard to override"),
    ]);
    const hits = await matchPromptDecisions(store, "add a button to the settings page", { embedModel: null });
    expect(hits).toEqual([]);
  });

  it("excludes suppressed (rejected) decisions", async () => {
    const store = new FakeStore(
      [decision("d:238", "Derive the IV per message", "hardcoding a static IV was a vuln", ["src/crypto.ts"])],
      new Map(),
      new Set(["d:238"]),
    );
    const hits = await matchPromptDecisions(store, "hardcode the IV in crypto", { embedModel: null });
    expect(hits).toEqual([]);
  });

  it("caps the result at the top 3, best score first", async () => {
    const store = new FakeStore([
      decision("d:1", "retry backoff policy alpha", "retry backoff retry backoff"),
      decision("d:2", "retry backoff policy beta", "retry backoff"),
      decision("d:3", "retry policy gamma", "retry"),
      decision("d:4", "backoff policy delta", "backoff"),
    ]);
    const hits = await matchPromptDecisions(store, "retry backoff policy", { embedModel: null });
    expect(hits).toHaveLength(3);
    expect(hits[0]!.id).toBe("d:1"); // most query words present → highest keyword score
  });
});

describe("matchPromptDecisions — semantic + budget", () => {
  it("surfaces a semantically-close decision that shares no words with the prompt", async () => {
    const embeddings = new Map<string, Float32Array>([
      ["d:A", Float32Array.from([1, 0])],
      ["d:B", Float32Array.from([0, 1])],
    ]);
    const store = new FakeStore(
      [
        decision("d:A", "use exponential backoff for outbound requests", "thundering herd took down the API"),
        decision("d:B", "store timestamps in UTC", "mixed zones caused off-by-one bugs"),
      ],
      embeddings,
    );
    // prompt shares no tokens with either summary, but embeds parallel to d:A
    const embed = new FakeEmbed(async () => [Float32Array.from([1, 0])]);
    const hits = await matchPromptDecisions(store, "should the client slow down when the server is overwhelmed", {
      embedModel: embed,
    });
    expect(hits.map((h) => h.id)).toEqual(["d:A"]);
  });

  it("requires a minimum cosine — a weakly-similar decision does not surface", async () => {
    const embeddings = new Map<string, Float32Array>([
      ["d:hi", Float32Array.from([0.8, 0.6])], // cosine 0.80 with the query → clears the bar
      ["d:lo", Float32Array.from([0.55, 0.8352])], // cosine 0.55 → below the 0.6 floor
    ]);
    const store = new FakeStore(
      [decision("d:hi", "alpha widget", "gamma"), decision("d:lo", "beta gadget", "delta")],
      embeddings,
    );
    const embed = new FakeEmbed(async () => [Float32Array.from([1, 0])]);
    const hits = await matchPromptDecisions(store, "should the client slow down when the server is overwhelmed", {
      embedModel: embed,
    });
    expect(hits.map((h) => h.id)).toEqual(["d:hi"]);
  });

  it("falls back to keyword-only when the embedder hangs past the budget", async () => {
    const store = new FakeStore(
      [decision("d:nonce", "Derive a per-message nonce in the cipher", "reusing a static nonce leaked plaintext", ["src/cipher.ts"])],
      new Map([["d:nonce", Float32Array.from([1, 0])]]),
    );
    const hang = new FakeEmbed(() => new Promise<Float32Array[]>(() => {})); // never resolves
    const started = performance.now();
    const hits = await matchPromptDecisions(store, "why do we derive a fresh nonce", { embedModel: hang, budgetMs: 50 });
    // keyword still finds it, and we didn't wait on the hung embedder
    expect(hits.map((h) => h.id)).toEqual(["d:nonce"]);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("falls back to keyword-only when the embedder is unreachable (throws)", async () => {
    const store = new FakeStore(
      [decision("d:nonce", "Derive a per-message nonce", "reusing a static nonce leaked plaintext")],
      new Map([["d:nonce", Float32Array.from([1, 0])]]),
    );
    const down = new FakeEmbed(() => Promise.reject(new EmbeddingError("cannot reach Ollama")));
    const hits = await matchPromptDecisions(store, "why derive a nonce per message", { embedModel: down });
    expect(hits.map((h) => h.id)).toEqual(["d:nonce"]);
  });

  it("stays silent (no throw) on an empty prompt", async () => {
    const store = new FakeStore([decision("d:1", "anything", "anything")]);
    expect(await matchPromptDecisions(store, "   ", { embedModel: null })).toEqual([]);
  });
});

describe("matchPromptDecisions — relevance gate", () => {
  it("skips a generic prompt with no distinctive terms without touching the store", async () => {
    let byKindCalls = 0;
    const store: DecisionSource = {
      byKind: async () => {
        byKindCalls++;
        return [decision("d:x", "alpha", "beta")];
      },
      embeddingsByKind: () => new Map(),
      suppressedDecisions: () => new Set(),
    };
    const hits = await matchPromptDecisions(store, "list the directories in this repo", { embedModel: null });
    expect(hits).toEqual([]);
    expect(byKindCalls).toBe(0); // no lookup at all — cheaper and safer
  });
});

// The field-finding calibration cases, pinned. FPE + Snowflake decisions in one store; each prompt
// must land exactly where the finding says it should. Keyword path (deterministic, no embedder).
describe("matchPromptDecisions — calibration (pinned field cases)", () => {
  const store = new FakeStore([
    decision(
      "258",
      "Removed the fixed IV from the FPE sample",
      "the fixed IV was reintroduced twice; FPE format-preserving encryption must use a per-call nonce",
      ["samples/fpe/cipher.ts"],
      { prNumber: 258 },
    ),
    decision(
      "238",
      "Derive the IV per message in the FPE sample",
      "a hardcoded IV in the FPE routine broke format-preserving encryption; derive it from the tweak",
      ["samples/fpe/cipher.ts"],
      { prNumber: 238 },
    ),
    decision(
      "248",
      "Snowflake sample uses key-pair auth, not a password",
      "the Snowflake connector sample must authenticate with a key pair; embedding a password was rejected",
      ["samples/snowflake/conn.ts"],
      { prNumber: 248 },
    ),
  ]);

  it("'fixed IV in the FPE sample' → #258 and #238 surface", async () => {
    const hits = await matchPromptDecisions(store, "fixed IV in the FPE sample", { embedModel: null });
    expect(hits.map((h) => h.id).sort()).toEqual(["238", "258"]);
  });

  it("'list the directories in this repo' → empty", async () => {
    const hits = await matchPromptDecisions(store, "list the directories in this repo", { embedModel: null });
    expect(hits).toEqual([]);
  });

  it("'how do I run the Snowflake sample?' → #248 only", async () => {
    const hits = await matchPromptDecisions(store, "how do I run the Snowflake sample?", { embedModel: null });
    expect(hits.map((h) => h.id)).toEqual(["248"]);
  });
});

describe("renderAdditionalContext", () => {
  it("renders one compact line per decision with receipt + files", () => {
    const ctx = renderAdditionalContext([
      { id: "d:238", summary: "Derive the IV per message", receipt: "https://github.com/o/r/pull/238", files: ["src/crypto.ts"], score: 1 },
    ]);
    expect(ctx).toContain("`why`");
    expect(ctx).toContain("- Derive the IV per message — https://github.com/o/r/pull/238 (files: src/crypto.ts)");
  });

  it("is empty when there are no matches", () => {
    expect(renderAdditionalContext([])).toBe("");
  });

  it("caps the total output size", () => {
    const long = "x".repeat(5000);
    const matches = Array.from({ length: 3 }, (_, i) => ({
      id: `d:${i}`,
      summary: long,
      receipt: long,
      files: Array.from({ length: 20 }, (_, j) => `file-${j}-${long}.ts`),
      score: 1,
    }));
    const ctx = renderAdditionalContext(matches);
    expect(ctx.length).toBeLessThanOrEqual(1200);
    expect(ctx.endsWith("…")).toBe(true); // truncated with an ellipsis
  });
});

describe("parseHookPrompt", () => {
  it("extracts the prompt from a UserPromptSubmit payload", () => {
    expect(parseHookPrompt(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "hello" }))).toBe("hello");
  });

  it("ignores malformed JSON silently (returns null)", () => {
    expect(parseHookPrompt("{ not json")).toBeNull();
    expect(parseHookPrompt("")).toBeNull();
    expect(parseHookPrompt("null")).toBeNull();
    expect(parseHookPrompt("[1,2,3]")).toBeNull();
  });

  it("returns null when there is no usable prompt field", () => {
    expect(parseHookPrompt(JSON.stringify({ prompt: 42 }))).toBeNull();
    expect(parseHookPrompt(JSON.stringify({ prompt: "   " }))).toBeNull();
    expect(parseHookPrompt(JSON.stringify({ other: "x" }))).toBeNull();
  });
});

describe("buildHookOutput", () => {
  it("wraps the context in the UserPromptSubmit hook control JSON", () => {
    const out = JSON.parse(buildHookOutput("some context")) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(out.hookSpecificOutput.additionalContext).toBe("some context");
  });
});
