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
  it("surfaces a decision whose summary/rationale shares words with the prompt", async () => {
    const store = new FakeStore([
      decision("d:238", "Derive the IV per message", "hardcoding a static IV made nonce reuse a vuln", ["src/crypto.ts"]),
      decision("d:99", "Prefer flat config files", "nested config was hard to override", ["src/config.ts"]),
    ]);
    const hits = await matchPromptDecisions(store, "can we just hardcode the IV again to simplify crypto", {
      embedModel: null,
    });
    expect(hits.map((h) => h.id)).toEqual(["d:238"]);
    expect(hits[0]!.files).toEqual(["src/crypto.ts"]);
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

  it("falls back to keyword-only when the embedder hangs past the budget", async () => {
    const store = new FakeStore(
      [decision("d:238", "Derive the IV per message", "hardcoding a static IV was a vuln", ["src/crypto.ts"])],
      new Map([["d:238", Float32Array.from([1, 0])]]),
    );
    const hang = new FakeEmbed(() => new Promise<Float32Array[]>(() => {})); // never resolves
    const started = performance.now();
    const hits = await matchPromptDecisions(store, "hardcode the IV in crypto", { embedModel: hang, budgetMs: 50 });
    // keyword still finds it, and we didn't wait on the hung embedder
    expect(hits.map((h) => h.id)).toEqual(["d:238"]);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("falls back to keyword-only when the embedder is unreachable (throws)", async () => {
    const store = new FakeStore(
      [decision("d:238", "Derive the IV per message", "hardcoding a static IV was a vuln")],
      new Map([["d:238", Float32Array.from([1, 0])]]),
    );
    const down = new FakeEmbed(() => Promise.reject(new EmbeddingError("cannot reach Ollama")));
    const hits = await matchPromptDecisions(store, "hardcode the IV", { embedModel: down });
    expect(hits.map((h) => h.id)).toEqual(["d:238"]);
  });

  it("stays silent (no throw) on an empty prompt", async () => {
    const store = new FakeStore([decision("d:1", "anything", "anything")]);
    expect(await matchPromptDecisions(store, "   ", { embedModel: null })).toEqual([]);
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
