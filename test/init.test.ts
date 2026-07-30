import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initMcpConfig, writeClaudeMdGuidance, writeSettingsHook } from "../src/init.js";
import { rmDir } from "./helpers/platform.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "keel-init-"));
});
afterEach(() => {
  rmDir(dir);
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

describe("keel init — CLAUDE.md agent guidance", () => {
  const CLAUDE = (): string => path.join(dir, "CLAUDE.md");
  const START = "<!-- keel:guidance:start -->";
  const END = "<!-- keel:guidance:end -->";

  it("creates CLAUDE.md with the guidance when none exists", () => {
    const result = writeClaudeMdGuidance(dir);
    if ("error" in result) throw new Error(result.error);
    expect(result.action).toBe("created");

    const md = fs.readFileSync(CLAUDE(), "utf8");
    expect(md).toContain(START);
    expect(md).toContain(END);
    expect(md).toContain("## Working with Keel");
    // the four moments are all present
    expect(md).toContain("call `context`");
    expect(md).toContain("call `why`");
    expect(md).toContain("call `preflight`");
    expect(md).toContain("run `verdict`");
  });

  it("appends to an existing CLAUDE.md, preserving what was there", () => {
    fs.writeFileSync(CLAUDE(), "# My Project\n\nHouse rules: use tabs.\n");
    const result = writeClaudeMdGuidance(dir);
    if ("error" in result) throw new Error(result.error);
    expect(result.action).toBe("updated");

    const md = fs.readFileSync(CLAUDE(), "utf8");
    expect(md).toContain("# My Project"); // original content intact
    expect(md).toContain("House rules: use tabs.");
    expect(md.indexOf("House rules")).toBeLessThan(md.indexOf(START)); // appended AFTER the user's text
  });

  it("is idempotent: a re-run makes no change", () => {
    fs.writeFileSync(CLAUDE(), "# My Project\n");
    writeClaudeMdGuidance(dir);
    const afterFirst = fs.readFileSync(CLAUDE(), "utf8");

    const second = writeClaudeMdGuidance(dir);
    if ("error" in second) throw new Error(second.error);
    expect(second.action).toBe("unchanged");
    expect(fs.readFileSync(CLAUDE(), "utf8")).toBe(afterFirst); // byte-identical
  });

  it("refreshes only the managed region, keeping content the user wrote after it", () => {
    writeClaudeMdGuidance(dir); // creates the block
    // A human appends their own section below Keel's block.
    fs.appendFileSync(CLAUDE(), "\n## My own notes\n\nkeep me.\n");
    const withTail = fs.readFileSync(CLAUDE(), "utf8");

    const result = writeClaudeMdGuidance(dir); // re-run
    if ("error" in result) throw new Error(result.error);
    // Exactly one managed block, and the user's trailing section survives.
    const md = fs.readFileSync(CLAUDE(), "utf8");
    expect(md.match(new RegExp(START, "g"))?.length).toBe(1);
    expect(md).toContain("## My own notes");
    expect(md).toContain("keep me.");
    expect(md).toBe(withTail); // nothing changed (the block was already current)
  });
});

describe("keel init — prompt-context hook (.claude/settings.json)", () => {
  const SETTINGS = (): string => path.join(dir, ".claude", "settings.json");
  function readSettings(): Record<string, any> {
    return JSON.parse(fs.readFileSync(SETTINGS(), "utf8"));
  }
  function promptContextCommands(s: Record<string, any>): string[] {
    return (s.hooks?.UserPromptSubmit ?? [])
      .flatMap((g: any) => g.hooks ?? [])
      .map((h: any) => h.command)
      .filter((c: string) => c.includes("prompt-context"));
  }

  it("creates .claude/settings.json (and the dir) with the hook when none exists", () => {
    const result = writeSettingsHook(dir, "keel");
    if ("error" in result) throw new Error(result.error);
    expect(result.action).toBe("created");
    expect(result.path).toBe(SETTINGS());

    const cmds = promptContextCommands(readSettings());
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toBe('KEEL_REPO="$CLAUDE_PROJECT_DIR" keel prompt-context');
  });

  it("mirrors the launch command it's given", () => {
    writeSettingsHook(dir, "node ./dist/index.js");
    expect(promptContextCommands(readSettings())[0]).toBe(
      'KEEL_REPO="$CLAUDE_PROJECT_DIR" node ./dist/index.js prompt-context',
    );
  });

  it("merges into an existing settings.json, preserving other hooks and keys", () => {
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    fs.writeFileSync(
      SETTINGS(),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "keel verdict --hook" }] }] },
        model: "sonnet",
      }),
    );
    const result = writeSettingsHook(dir, "keel");
    if ("error" in result) throw new Error(result.error);
    expect(result.action).toBe("updated");

    const s = readSettings();
    expect(s.model).toBe("sonnet"); // untouched top-level key
    expect(s.hooks.Stop[0].hooks[0].command).toBe("keel verdict --hook"); // untouched Stop hook
    expect(promptContextCommands(s)).toHaveLength(1); // our hook added
  });

  it("is idempotent: a re-run with the same command reports no change", () => {
    writeSettingsHook(dir, "keel");
    const before = fs.readFileSync(SETTINGS(), "utf8");
    const result = writeSettingsHook(dir, "keel");
    if ("error" in result) throw new Error(result.error);

    expect(result.action).toBe("unchanged");
    expect(fs.readFileSync(SETTINGS(), "utf8")).toBe(before); // byte-identical
  });

  it("updates the command in place without duplicating when it changes", () => {
    writeSettingsHook(dir, "keel");
    const result = writeSettingsHook(dir, "node ./dist/index.js");
    if ("error" in result) throw new Error(result.error);

    expect(result.action).toBe("updated");
    const cmds = promptContextCommands(readSettings());
    expect(cmds).toHaveLength(1); // replaced, not appended
    expect(cmds[0]).toBe('KEEL_REPO="$CLAUDE_PROJECT_DIR" node ./dist/index.js prompt-context');
  });

  it("refuses to overwrite an unparseable settings.json", () => {
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    fs.writeFileSync(SETTINGS(), "{ not valid json ");
    const result = writeSettingsHook(dir, "keel");

    expect("error" in result).toBe(true);
    expect(fs.readFileSync(SETTINGS(), "utf8")).toBe("{ not valid json "); // left exactly as-is
  });
});
