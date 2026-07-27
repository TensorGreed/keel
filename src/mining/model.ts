/**
 * The model behind the decision miner. DecisionModel is the injectable seam — tests use a
 * fake, never the network. Two real backends, both over Node's global fetch (no deps):
 * OllamaModel (local, free — the default) and AnthropicModel (batch Haiku-class).
 *
 * IMPORTANT: model calls happen ONLY here, only in the offline `keel mine` pipeline — never
 * in the MCP server. Cheap/local models are the only ones permitted, per CLAUDE.md's cost
 * rules; this is not a place for flagship-model reasoning.
 */

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
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt, stream: false, format: "json" }),
      });
    } catch (err) {
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
    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
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
      });
    } catch (err) {
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
