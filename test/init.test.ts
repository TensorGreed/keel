import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initMcpConfig } from "../src/init.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-init-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function readConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8"));
}

describe("keel init", () => {
  it("creates .mcp.json when none exists", () => {
    const result = initMcpConfig({ dir });
    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.action).toBe("created");
    expect(result.path).toBe(path.join(dir, ".mcp.json"));
    expect(readConfig()).toEqual({
      mcpServers: { keel: { command: "keel", env: { KEEL_REPO: "." } } },
    });
    // pretty-printed with a trailing newline
    expect(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8")).toMatch(/\n$/);
  });

  it("merges into an existing config without disturbing other servers", () => {
    fs.writeFileSync(
      path.join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: { other: { command: "other-server" } },
        someTopLevel: 42,
      }),
    );

    const result = initMcpConfig({ dir });
    expect("error" in result && result.error).toBeFalsy();
    if ("error" in result) return;

    expect(result.action).toBe("updated");
    expect(readConfig()).toEqual({
      mcpServers: {
        other: { command: "other-server" },
        keel: { command: "keel", env: { KEEL_REPO: "." } },
      },
      someTopLevel: 42,
    });
  });

  it("is idempotent: a second identical run reports no change", () => {
    initMcpConfig({ dir });
    const before = fs.readFileSync(path.join(dir, ".mcp.json"), "utf8");
    const result = initMcpConfig({ dir });
    if ("error" in result) throw new Error(result.error);

    expect(result.action).toBe("unchanged");
    expect(fs.readFileSync(path.join(dir, ".mcp.json"), "utf8")).toBe(before);
  });

  it("updates the keel entry when the command differs", () => {
    initMcpConfig({ dir });
    const result = initMcpConfig({ dir, command: "node ./dist/index.js" });
    if ("error" in result) throw new Error(result.error);

    expect(result.action).toBe("updated");
    expect(readConfig()).toEqual({
      mcpServers: { keel: { command: "node ./dist/index.js", env: { KEEL_REPO: "." } } },
    });
  });

  it("honors a custom server name", () => {
    initMcpConfig({ dir });
    initMcpConfig({ dir, serverName: "keel-web" });
    expect(Object.keys(readConfig().mcpServers as object).sort()).toEqual(["keel", "keel-web"]);
  });

  it("refuses to overwrite an unparseable .mcp.json", () => {
    const configPath = path.join(dir, ".mcp.json");
    fs.writeFileSync(configPath, "{ not valid json ");
    const result = initMcpConfig({ dir });

    expect("error" in result).toBe(true);
    // file left exactly as it was
    expect(fs.readFileSync(configPath, "utf8")).toBe("{ not valid json ");
  });

  it("refuses to clobber a non-object mcpServers", () => {
    const configPath = path.join(dir, ".mcp.json");
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: [1, 2, 3] }));
    const result = initMcpConfig({ dir });

    expect("error" in result).toBe(true);
    expect(readConfig()).toEqual({ mcpServers: [1, 2, 3] });
  });

  it("treats an empty file as a fresh config", () => {
    fs.writeFileSync(path.join(dir, ".mcp.json"), "");
    const result = initMcpConfig({ dir });
    if ("error" in result) throw new Error(result.error);

    expect(result.action).toBe("updated"); // the file existed, even if empty
    expect(readConfig()).toEqual({
      mcpServers: { keel: { command: "keel", env: { KEEL_REPO: "." } } },
    });
  });
});
