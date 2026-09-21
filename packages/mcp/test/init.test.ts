import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clientConfigPath, ensureKey, mergeConfig, parseInitArgs, serverEntry } from "../src/cli/init.js";

const entry = { command: "/usr/bin/node", args: ["/x/server.js"], env: { CRA_NETWORK: "arc", CRA_KEY_FILE: "/k", CRA_POLICY: "daily=1" } };

describe("cra-agent init", () => {
  it("makes a key only its owner can read, and never replaces one that is there", () => {
    const path = join(mkdtempSync(join(tmpdir(), "cra-init-")), "nested", "agent.key");
    const first = ensureKey(path);
    expect(first.created).toBe(true);
    expect(first.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const before = readFileSync(path, "utf8");
    const second = ensureKey(path);
    expect(second).toEqual({ address: first.address, created: false });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("writes nothing on a dry run", () => {
    const path = join(mkdtempSync(join(tmpdir(), "cra-init-")), "agent.key");
    expect(ensureKey(path, true).created).toBe(true);
    expect(() => statSync(path)).toThrow();
  });

  it("adds its entry and leaves every other server and setting as it was", () => {
    const existing = JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" }, "cra-agent": { command: "old" } } });
    const doc = JSON.parse(mergeConfig(existing, entry));
    expect(doc.theme).toBe("dark");
    expect(doc.mcpServers.other).toEqual({ command: "x" });
    expect(doc.mcpServers["cra-agent"]).toEqual(entry);
    expect(JSON.parse(mergeConfig(null, entry)).mcpServers["cra-agent"]).toEqual(entry);
    expect(JSON.parse(mergeConfig("", entry)).mcpServers["cra-agent"]).toEqual(entry);
  });

  it("refuses to touch a config file it cannot read as JSON", () => {
    expect(() => mergeConfig("{ not json", entry)).toThrow(/Nothing was changed/);
    expect(() => mergeConfig("[]", entry)).toThrow(/Nothing was changed/);
  });

  it("refuses limits with a typo instead of running without them", () => {
    expect(() => parseInitArgs(["--policy", "dayly=5"])).toThrow(/unknown key/);
    expect(() => parseInitArgs(["--client", "word"])).toThrow(/--client/);
    expect(() => parseInitArgs(["--oops", "1"])).toThrow(/unknown option/);
  });

  it("defaults to the cautious limits and a key under the home folder, and takes both flag styles", () => {
    const o = parseInitArgs([], "/home/ada");
    expect(o).toMatchObject({ client: "claude-desktop", network: "arc", keyFile: "/home/ada/.cra-agent/agent.key", dryRun: false });
    expect(o.policy).toContain("allow=api.cra-agent.tech");
    expect(parseInitArgs(["--client=cursor", "--key-file", "~/k/agent.key", "--dry-run"], "/home/ada")).toMatchObject({ client: "cursor", keyFile: "/home/ada/k/agent.key", dryRun: true });
  });

  it("knows where each client keeps its servers, and launches by full path", () => {
    expect(clientConfigPath("claude-desktop", "darwin", "/Users/ada")).toBe("/Users/ada/Library/Application Support/Claude/claude_desktop_config.json");
    expect(clientConfigPath("claude-desktop", "linux", "/home/ada", {})).toBe("/home/ada/.config/Claude/claude_desktop_config.json");
    expect(clientConfigPath("cursor", "darwin", "/Users/ada")).toBe("/Users/ada/.cursor/mcp.json");
    expect(clientConfigPath("claude-code")).toBeNull();
    const e = serverEntry(parseInitArgs([], "/home/ada"));
    expect(e.command).toMatch(/^(\/|[A-Z]:\\)/);
    expect(e.args[0]).toMatch(/server\.js$/);
    expect(Object.keys(e.env)).toEqual(["CRA_NETWORK", "CRA_KEY_FILE", "CRA_POLICY"]);
  });
});
