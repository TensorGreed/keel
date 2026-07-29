import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  execFileSyncTimed,
  execFileTimed,
  fetchTimed,
  gitTimeoutMs,
  httpTimeoutMs,
  modelTimeoutMs,
  ollamaEmbedTimeoutMs,
  ollamaGenerateTimeoutMs,
  runnerTimeoutMs,
} from "../src/util/timeouts.js";

const ENV_KEYS = [
  "KEEL_HTTP_TIMEOUT",
  "KEEL_GIT_TIMEOUT",
  "KEEL_OLLAMA_TIMEOUT",
  "KEEL_OLLAMA_EMBED_TIMEOUT",
  "KEEL_MODEL_TIMEOUT",
  "KEEL_RUNNER_TIMEOUT",
] as const;

describe("timeout getters: defaults and env overrides", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("defaults every category when no env var is set", () => {
    expect(httpTimeoutMs()).toBe(30_000);
    expect(gitTimeoutMs()).toBe(20_000);
    expect(ollamaGenerateTimeoutMs()).toBe(60_000);
    expect(ollamaEmbedTimeoutMs()).toBe(20_000);
    expect(modelTimeoutMs()).toBe(60_000);
    expect(runnerTimeoutMs()).toBe(120_000);
  });

  it("reads each override in seconds, converted to ms", () => {
    process.env["KEEL_HTTP_TIMEOUT"] = "5";
    process.env["KEEL_GIT_TIMEOUT"] = "3";
    process.env["KEEL_OLLAMA_TIMEOUT"] = "7";
    process.env["KEEL_OLLAMA_EMBED_TIMEOUT"] = "2";
    process.env["KEEL_MODEL_TIMEOUT"] = "9";
    process.env["KEEL_RUNNER_TIMEOUT"] = "11";
    expect(httpTimeoutMs()).toBe(5_000);
    expect(gitTimeoutMs()).toBe(3_000);
    expect(ollamaGenerateTimeoutMs()).toBe(7_000);
    expect(ollamaEmbedTimeoutMs()).toBe(2_000);
    expect(modelTimeoutMs()).toBe(9_000);
    expect(runnerTimeoutMs()).toBe(11_000);
  });

  it("falls back to the default on a non-numeric or non-positive override", () => {
    process.env["KEEL_HTTP_TIMEOUT"] = "not-a-number";
    expect(httpTimeoutMs()).toBe(30_000);
    process.env["KEEL_HTTP_TIMEOUT"] = "-5";
    expect(httpTimeoutMs()).toBe(30_000);
    process.env["KEEL_HTTP_TIMEOUT"] = "0";
    expect(httpTimeoutMs()).toBe(30_000);
  });
});

describe("execFileTimed", () => {
  it("resolves stdout/stderr on a fast command", async () => {
    const { stdout } = await execFileTimed(process.execPath, ["-e", "process.stdout.write('ok')"], { timeoutMs: 5_000 });
    expect(stdout).toBe("ok");
  });

  it("kills a slow command and rejects with a clear, resumable message", async () => {
    await expect(
      execFileTimed(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 100, label: "slow node" }),
    ).rejects.toThrow(/slow node timed out after/);
  });

  it("pipes stdin via the input option", async () => {
    const { stdout } = await execFileTimed(
      process.execPath,
      ["-e", "process.stdin.on('data', d => process.stdout.write(d))"],
      { timeoutMs: 5_000, input: "hello" },
    );
    expect(stdout).toBe("hello");
  });
});

describe("execFileSyncTimed", () => {
  it("returns stdout on a fast command", () => {
    const out = execFileSyncTimed(process.execPath, ["-e", "process.stdout.write('ok')"], { timeoutMs: 5_000 });
    expect(out).toBe("ok");
  });

  it("throws a clear, resumable message on timeout", () => {
    expect(() => execFileSyncTimed(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 100 })).toThrow(
      /timed out after/,
    );
  });
});

describe("fetchTimed", () => {
  let server: http.Server;
  let url: string;

  beforeEach(async () => {
    server = http.createServer((_req, res) => {
      setTimeout(() => res.end("slow"), 2_000);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}/`;
  });

  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("aborts a slow response once the timeout elapses", async () => {
    await expect(fetchTimed(url, {}, 100, "slow endpoint")).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
