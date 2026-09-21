/**
 * `cra-agent init`: everything between "installed" and "ready to pay", on the user's own machine.
 *
 * It makes the agent's key if there is none, checks the spending limits with the same parser the
 * rail uses, and writes the MCP entry into the AI client's config file, keeping a copy of what was
 * there. The key is created here and nowhere else: no web page, no network call. An existing key is
 * never overwritten, and a config file that does not parse is never touched.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describePolicy, parsePolicyString } from "@cra-agent/policy";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

export type InitClient = "claude-desktop" | "cursor" | "claude-code" | "terminal";
const CLIENTS: readonly InitClient[] = ["claude-desktop", "cursor", "claude-code", "terminal"];

export interface InitOptions {
  readonly client: InitClient;
  readonly network: "arc" | "arcTestnet";
  readonly policy: string;
  readonly keyFile: string;
  readonly dryRun: boolean;
}

export function parseInitArgs(argv: readonly string[], home = homedir()): InitOptions {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new Error(`init: unexpected "${a}"`);
    const eq = a.indexOf("=");
    if (eq > 0) flags.set(a.slice(2, eq), a.slice(eq + 1));
    else if (a === "--dry-run") flags.set("dry-run", "1");
    else flags.set(a.slice(2), argv[++i] ?? "");
  }
  for (const k of flags.keys()) if (!["client", "network", "policy", "key-file", "dry-run"].includes(k)) throw new Error(`init: unknown option --${k}`);
  const client = (flags.get("client") ?? "claude-desktop") as InitClient;
  if (!CLIENTS.includes(client)) throw new Error(`init: --client is one of ${CLIENTS.join(", ")}`);
  const network = flags.get("network") ?? "arc";
  if (network !== "arc" && network !== "arcTestnet") throw new Error("init: --network is arc or arcTestnet");
  const policy = flags.get("policy") ?? "daily=1,per_seller=1,per_payment=0.01,rate=10/60s,allow=api.cra-agent.tech";
  // Throws on a typo: a limit that did not parse must not become no limit.
  parsePolicyString(policy);
  const keyFile = resolve((flags.get("key-file") ?? join(home, ".cra-agent", "agent.key")).replace(/^~(?=\/|\\|$)/, home));
  return { client, network, policy, keyFile, dryRun: flags.has("dry-run") };
}

/** The agent's address, from the key at `path`, which is created when there is none. */
export function ensureKey(path: string, dryRun = false): { address: string; created: boolean } {
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8").trim();
    return { address: privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex).address, created: false };
  }
  const key = generatePrivateKey();
  if (!dryRun) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // "wx": fail rather than replace, should a key appear between the check and the write.
    writeFileSync(path, `${key}\n`, { mode: 0o600, flag: "wx" });
  }
  return { address: privateKeyToAccount(key).address, created: true };
}

/** Where each client keeps its MCP servers. Null when the client is configured by a command instead. */
export function clientConfigPath(client: InitClient, platform: NodeJS.Platform = process.platform, home = homedir(), env: NodeJS.ProcessEnv = process.env): string | null {
  if (client === "cursor") return join(home, ".cursor", "mcp.json");
  if (client !== "claude-desktop") return null;
  if (platform === "darwin") return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "Claude", "claude_desktop_config.json");
}

export interface ServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * The entry a client launches. Node and the server are named by full path: an app started from the
 * dock does not inherit the shell's PATH, and "cra-agent-mcp" alone is the usual reason a freshly
 * configured MCP server "does nothing".
 */
export function serverEntry(o: InitOptions, node = process.execPath, server = fileURLToPath(new URL("../server.js", import.meta.url))): ServerEntry {
  return { command: node, args: [server], env: { CRA_NETWORK: o.network, CRA_KEY_FILE: o.keyFile, CRA_POLICY: o.policy } };
}

/** The config text with our entry in it and everything else as it was. Throws if the existing text is not JSON. */
export function mergeConfig(existing: string | null, entry: ServerEntry): string {
  let doc: Record<string, unknown> = {};
  if (existing !== null && existing.trim() !== "") {
    try {
      doc = JSON.parse(existing) as Record<string, unknown>;
    } catch {
      throw new Error("the existing config file is not valid JSON; fix or move it, then run init again. Nothing was changed.");
    }
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new Error("the existing config file is not a JSON object. Nothing was changed.");
  }
  const servers = typeof doc.mcpServers === "object" && doc.mcpServers !== null && !Array.isArray(doc.mcpServers) ? (doc.mcpServers as Record<string, unknown>) : {};
  return `${JSON.stringify({ ...doc, mcpServers: { ...servers, "cra-agent": entry } }, null, 2)}\n`;
}

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export function runInit(argv: readonly string[], print: (line: string) => void = console.log): void {
  const o = parseInitArgs(argv);
  const say = (s = ""): void => print(s);
  if (o.dryRun) say("Dry run: nothing is written.\n");

  const key = ensureKey(o.keyFile, o.dryRun);
  say(key.created ? `New key for the agent: ${o.keyFile} (readable only by you)` : `Keeping the key already at ${o.keyFile}`);
  say(`Agent address: ${key.address}`);
  say();

  const limits = describePolicy(parsePolicyString(o.policy));
  say(`Limits: $${limits.perPaymentCapUsdc} per payment, $${limits.perCounterpartyDailyCapUsdc} per seller per day, $${limits.dailyCapUsdc} per day, ${limits.rateLimit}.`);
  const allow = limits.allowlist as string[] | null | undefined;
  say(allow && allow.length ? `May pay only: ${allow.join(", ")}` : "May pay any x402 seller, within those limits.");
  say();

  const entry = serverEntry(o);
  const path = clientConfigPath(o.client);
  const envArgs = Object.entries(entry.env).map(([k, v]) => `${k}=${quote(v)}`);
  if (path) {
    const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
    const next = mergeConfig(existing, entry);
    if (!o.dryRun) {
      mkdirSync(dirname(path), { recursive: true });
      if (existing !== null) {
        const backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        copyFileSync(path, backup);
        say(`Copy of your previous config: ${backup}`);
      }
      writeFileSync(path, next);
    }
    say(`${o.dryRun ? "Would write" : "Wrote"} the cra-agent entry to ${path}`);
    say(`Restart ${o.client === "cursor" ? "Cursor" : "Claude"} to load it.`);
  } else if (o.client === "claude-code") {
    say("Run this once, in the folder where you use Claude Code:");
    say(`  claude mcp add cra-agent ${envArgs.map((e) => `-e ${e}`).join(" ")} -- ${quote(entry.command)} ${quote(entry.args[0]!)}`);
  } else {
    say("Paste these in the terminal you will use:");
    for (const e of envArgs) say(`  export ${e}`);
  }

  say();
  say("Next:");
  say(`  1. Send a few dollars of USDC on ${o.network === "arc" ? "Arc mainnet" : "Arc testnet"} to ${key.address}`);
  say(`  2. ${envArgs.join(" ")} cra-agent deposit 1`);
  say(o.client === "terminal" ? "  3. cra-agent pay 'https://api.cra-agent.tech/v1/paid/fx/execution?symbol=EURC'" : "  3. Ask your AI: \"Use the cra-agent tools: show me the policy, quote https://api.cra-agent.tech/v1/paid/fx/execution?symbol=EURC and pay for it if the policy allows.\"");
  say();
  say("The agent can never spend more than what you send it, or more than the limits above. Never paste the key anywhere.");
}
