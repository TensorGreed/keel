import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteEventStore } from "../src/events/sqlite-store.js";
import type { KeelEvent } from "../src/events/store.js";
import { DEFAULT_OPENAI_BASE_URL, MinerModelError, OpenAICompatibleModel } from "../src/mining/model.js";
import { mineDecisions } from "../src/mining/mine.js";
import { selectModel } from "../src/mining/cli.js";

// The OpenAI-compatible mining backend. All over a stubbed global fetch — never the network.
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

interface Call {
  url: string;
  init: RequestInit;
}
function stubFetch(handler: () => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler();
  }) as unknown as typeof fetch;
  return calls;
}
function chatResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}
function errorResponse(status: number): Response {
  return new Response(JSON.stringify({ error: { message: "boom" } }), { status });
}

describe("OpenAICompatibleModel", () => {
  it("POSTs {base}/chat/completions with the model, a user message, temperature 0, and a bearer token", async () => {
    const calls = stubFetch(() => chatResponse('{"hasDecision": true, "summary": "x"}'));
    const model = new OpenAICompatibleModel("gpt-4o-mini", "sk-key");

    const out = await model.complete("PROMPT TEXT");

    expect(out).toBe('{"hasDecision": true, "summary": "x"}'); // choices[0].message.content
    expect(model.name).toBe("openai:gpt-4o-mini");
    const { url, init } = calls[0]!;
    expect(url).toBe(`${DEFAULT_OPENAI_BASE_URL}/chat/completions`);
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer sk-key");
    const sent = JSON.parse(init.body as string) as { model: string; temperature: number; messages: unknown[] };
    expect(sent.model).toBe("gpt-4o-mini");
    expect(sent.temperature).toBe(0);
    expect(sent.messages).toEqual([{ role: "user", content: "PROMPT TEXT" }]);
  });

  it("serves any provider through the base URL (DeepSeek-shaped)", async () => {
    const calls = stubFetch(() => chatResponse("{}"));
    await new OpenAICompatibleModel("deepseek-chat", "sk", "https://api.deepseek.com/v1").complete("p");
    expect(calls[0]!.url).toBe("https://api.deepseek.com/v1/chat/completions");
  });

  it("raises a MinerModelError on 429 / 401 / 5xx (surfaced as data upstream)", async () => {
    for (const status of [429, 401, 500]) {
      stubFetch(() => errorResponse(status));
      await expect(new OpenAICompatibleModel("m", "sk").complete("p")).rejects.toBeInstanceOf(MinerModelError);
    }
  });
});

describe("mine over the OpenAI backend — a rate limit leaves the PR unmarked for retry", () => {
  function seedPr(store: SqliteEventStore): void {
    const pr: KeelEvent = {
      kind: "pr",
      externalId: "o/r#7",
      occurredAt: "2021-01-01T00:00:00Z",
      actor: "a",
      title: "Add retry",
      payload: { number: 7, state: "closed", merged: true, author: "a", body: "b", url: "u", updatedAt: "2021-01-02T00:00:00Z", reviews: [] },
      files: ["src/x.ts"],
    };
    store.appendMany([pr]);
  }

  it("counts a 429 as a clean error and does NOT mark the PR mined (same contract as Ollama)", async () => {
    stubFetch(() => errorResponse(429));
    const store = new SqliteEventStore(":memory:");
    seedPr(store);

    const result = await mineDecisions(store, new OpenAICompatibleModel("deepseek-chat", "sk", "https://api.deepseek.com/v1"));

    expect(result.errors).toBe(1);
    expect(result.mined).toBe(0);
    expect(store.minedPrs().size).toBe(0); // unmarked → a re-run retries it
    store.close();
  });
});

describe("selectModel --model openai", () => {
  const saved = {
    key: process.env["OPENAI_API_KEY"],
    model: process.env["KEEL_MINER_MODEL"],
    base: process.env["KEEL_OPENAI_BASE_URL"],
  };
  afterEach(() => {
    for (const [k, v] of Object.entries({ OPENAI_API_KEY: saved.key, KEEL_MINER_MODEL: saved.model, KEEL_OPENAI_BASE_URL: saved.base })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("errors when OPENAI_API_KEY is missing", () => {
    delete process.env["OPENAI_API_KEY"];
    process.env["KEEL_MINER_MODEL"] = "deepseek-chat";
    const r = selectModel("openai");
    expect("error" in r && /OPENAI_API_KEY/.test(r.error)).toBe(true);
  });

  it("errors clearly when KEEL_MINER_MODEL is missing — no silent default for a paid API", () => {
    process.env["OPENAI_API_KEY"] = "sk";
    delete process.env["KEEL_MINER_MODEL"];
    const r = selectModel("openai");
    expect("error" in r && /KEEL_MINER_MODEL is required/.test(r.error)).toBe(true);
  });

  it("builds the model, naming it after the configured model", () => {
    process.env["OPENAI_API_KEY"] = "sk";
    process.env["KEEL_MINER_MODEL"] = "deepseek-chat";
    process.env["KEEL_OPENAI_BASE_URL"] = "https://api.deepseek.com/v1";
    const r = selectModel("openai");
    expect("error" in r).toBe(false);
    expect((r as OpenAICompatibleModel).name).toBe("openai:deepseek-chat");
  });
});
