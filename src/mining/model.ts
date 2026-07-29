/**
 * The model behind the decision miner. DecisionModel is the injectable seam — tests use a
 * fake, never the network. Three real backends, all over Node's global fetch (no deps):
 * OllamaModel (local, free — the default), AnthropicModel (batch Haiku-class), and
 * OpenAICompatibleModel (any OpenAI-compatible /chat/completions endpoint — a configurable
 * base URL makes one backend serve OpenAI, DeepSeek, Groq, Mistral, LM Studio, vLLM, …).
 *
 * IMPORTANT: model calls happen ONLY here, only in the offline `keel mine` pipeline — never
 * in the MCP server. Cheap/local models are the default and the only ones that run for free;
 * cloud providers stay confined to this offline pipeline, per CLAUDE.md's cost rules. This is
 * not a place for flagship-model reasoning.
 */
import { fetchTimed, modelTimeoutMs, ollamaGenerateTimeoutMs } from "../util/timeouts.js";

function isTimeout(err: unknown): boolean {
  const name = (err as Error)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

export interface DecisionModel {
  /** Complete a prompt to text. Throws MinerModelError on failure (surfaced as data upstream). */
  complete(prompt: string): Promise<string>;
  /** identifier for logging, e.g. "ollama:llama3.2" */
  readonly name: string;
}

export class MinerModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MinerModelError";
  }
}

const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_OLLAMA_MODEL = "llama3.2";
const DEFAULT_HAIKU_MODEL = "claude-haiku-4-5";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

/** Local Ollama via /api/generate. `format: "json"` nudges the model to emit valid JSON. */
export class OllamaModel implements DecisionModel {
  readonly name: string;

  constructor(
    private readonly model: string = DEFAULT_OLLAMA_MODEL,
    private readonly baseUrl: string = DEFAULT_OLLAMA_URL,
  ) {
    this.name = `ollama:${model}`;
  }

  async complete(prompt: string): Promise<string> {
    const timeoutMs = ollamaGenerateTimeoutMs();
    let res: Response;
    try {
      res = await fetchTimed(
        `${this.baseUrl.replace(/\/$/, "")}/api/generate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: this.model, prompt, stream: false, format: "json" }),
        },
        timeoutMs,
        `Ollama generate (${this.model})`,
      );
    } catch (err) {
      if (isTimeout(err)) {
        throw new MinerModelError(`Ollama at ${this.baseUrl} timed out after ${Math.round(timeoutMs / 1000)}s (raise KEEL_OLLAMA_TIMEOUT to allow longer)`);
      }
      throw new MinerModelError(`cannot reach Ollama at ${this.baseUrl}: ${(err as Error).message}`);
    }
    if (!res.ok) {
      throw new MinerModelError(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = (await res.json()) as { response?: string };
    return data.response ?? "";
  }
}

/** Anthropic Messages API with a Haiku-class model. Offline batch use only (see file header). */
export class AnthropicModel implements DecisionModel {
  readonly name: string;

  constructor(
    private readonly apiKey: string,
    private readonly model: string = DEFAULT_HAIKU_MODEL,
  ) {
    this.name = `anthropic:${model}`;
  }

  async complete(prompt: string): Promise<string> {
    const timeoutMs = modelTimeoutMs();
    let res: Response;
    try {
      res = await fetchTimed(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: this.model,
            max_tokens: 1024,
            messages: [{ role: "user", content: prompt }],
          }),
        },
        timeoutMs,
        `Anthropic (${this.model})`,
      );
    } catch (err) {
      if (isTimeout(err)) {
        throw new MinerModelError(`Anthropic API timed out after ${Math.round(timeoutMs / 1000)}s (raise KEEL_MODEL_TIMEOUT to allow longer)`);
      }
      throw new MinerModelError(`cannot reach the Anthropic API: ${(err as Error).message}`);
    }
    if (!res.ok) {
      let message = `${res.status}`;
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        if (body.error?.message) message = `${res.status}: ${body.error.message}`;
      } catch {
        /* keep the status */
      }
      throw new MinerModelError(`Anthropic API ${message}`);
    }
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    return (data.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
  }
}

/**
 * Any OpenAI-compatible `/chat/completions` endpoint, over global fetch (no SDK). The base URL is
 * what makes ONE backend serve OpenAI, DeepSeek, Groq, Mistral, LM Studio, vLLM, and more:
 *   - DeepSeek:  KEEL_OPENAI_BASE_URL=https://api.deepseek.com/v1, KEEL_MINER_MODEL=deepseek-chat
 *   - Groq:      KEEL_OPENAI_BASE_URL=https://api.groq.com/openai/v1
 *   - local:     KEEL_OPENAI_BASE_URL=http://localhost:1234/v1  (LM Studio / vLLM)
 * temperature 0 for reproducibility. A cloud provider — kept to this offline pipeline (CLAUDE.md).
 * 401/429/5xx surface as MinerModelError, so mine.ts leaves the PR unmarked and retries next run.
 */
export class OpenAICompatibleModel implements DecisionModel {
  readonly name: string;

  constructor(
    private readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl: string = DEFAULT_OPENAI_BASE_URL,
  ) {
    this.name = `openai:${model}`;
  }

  async complete(prompt: string): Promise<string> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const timeoutMs = modelTimeoutMs();
    let res: Response;
    try {
      res = await fetchTimed(
        url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0,
          }),
        },
        timeoutMs,
        `OpenAI-compatible (${this.model})`,
      );
    } catch (err) {
      if (isTimeout(err)) {
        throw new MinerModelError(`OpenAI-compatible API at ${this.baseUrl} timed out after ${Math.round(timeoutMs / 1000)}s (raise KEEL_MODEL_TIMEOUT to allow longer)`);
      }
      throw new MinerModelError(`cannot reach the OpenAI-compatible API at ${this.baseUrl}: ${(err as Error).message}`);
    }
    if (!res.ok) {
      let message = `${res.status}`;
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        if (body.error?.message) message = `${res.status}: ${body.error.message}`;
      } catch {
        /* keep the status */
      }
      throw new MinerModelError(`OpenAI-compatible API ${message}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  }
}
