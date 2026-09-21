/**
 * CRA Factory: turns a few answers into everything needed to run a paying agent.
 *
 * Pure functions, no page: what they produce is pasted into a terminal and a config file, so it is
 * tested against the real policy parser rather than trusted. Nothing here touches a key. The key is
 * made on the visitor's machine by a command they run, and this page never sees it.
 */
export type Client = "claude-desktop" | "claude-code" | "cursor" | "terminal";
export type Network = "arc" | "arcTestnet";

export interface FactoryInput {
  readonly client: Client;
  readonly network: Network;
  /** Dollars, as typed. */
  readonly daily: string;
  readonly perSeller: string;
  readonly perPayment: string;
  /** Payments per minute, or null for the default. */
  readonly perMinute: number | null;
  /** Sites the agent may pay. Empty means any. */
  readonly allow: readonly string[];
  /** Absolute path of the key file on the visitor's machine. */
  readonly keyFile: string;
}

export interface Preset {
  readonly id: string;
  readonly label: string;
  readonly explain: string;
  readonly values: Pick<FactoryInput, "daily" | "perSeller" | "perPayment" | "perMinute" | "allow">;
}

export const PRESETS: readonly Preset[] = [
  { id: "cautious", label: "Cautious", explain: "One dollar a day, one cent per call, and only our own API. For a first try.", values: { daily: "1", perSeller: "1", perPayment: "0.01", perMinute: 10, allow: ["api.cra-agent.tech"] } },
  { id: "standard", label: "Standard", explain: "Five dollars a day, five cents per call, any seller, but no single seller gets more than fifty cents a day.", values: { daily: "5", perSeller: "0.5", perPayment: "0.05", perMinute: 60, allow: [] } },
  { id: "worker", label: "Worker", explain: "Twenty-five dollars a day and twenty-five cents per call, for an agent that buys data all day.", values: { daily: "25", perSeller: "5", perPayment: "0.25", perMinute: 120, allow: [] } },
];

const AMOUNT = /^\d{1,6}(\.\d{1,6})?$/;
const HOST = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A site as the policy wants it: the host alone, whatever the visitor pasted. */
export function hostOf(raw: string): string {
  return raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "");
}

/** Everything wrong with the answers, in words. Empty when they can be turned into a config. */
export function problems(i: FactoryInput): string[] {
  const out: string[] = [];
  const amounts: Array<[string, string]> = [["The daily limit", i.daily], ["The limit per seller", i.perSeller], ["The limit per payment", i.perPayment]];
  for (const [name, v] of amounts) if (!AMOUNT.test(v) || Number(v) <= 0) out.push(`${name} must be an amount in dollars, like 0.05 or 5.`);
  if (out.length === 0) {
    if (Number(i.perPayment) > Number(i.perSeller)) out.push("One payment cannot be larger than what a single seller may receive in a day.");
    if (Number(i.perSeller) > Number(i.daily)) out.push("One seller cannot receive more in a day than the agent may spend in a day.");
  }
  if (i.perMinute !== null && (!Number.isInteger(i.perMinute) || i.perMinute < 1 || i.perMinute > 10_000)) out.push("Payments per minute must be a whole number, 1 or more.");
  for (const h of i.allow) if (!HOST.test(h)) out.push(`“${h}” is not a site name. Write it like api.example.com.`);
  if (!/^(\/|[A-Za-z]:\\)/.test(i.keyFile) || /["'`$\s]/.test(i.keyFile)) out.push("The key file must be a full path with no spaces or quotes, like /Users/you/.cra-agent/agent.key.");
  return out;
}

/** The limits in the compact form CRA_POLICY takes. */
export function policyString(i: FactoryInput): string {
  const parts = [`daily=${i.daily}`, `per_seller=${i.perSeller}`, `per_payment=${i.perPayment}`];
  if (i.perMinute !== null) parts.push(`rate=${i.perMinute}/60s`);
  if (i.allow.length > 0) parts.push(`allow=${i.allow.join("|")}`);
  return parts.join(",");
}

/** The limits as a sentence, so the visitor can check the agent will do what they meant. */
export function inWords(i: FactoryInput): string {
  const where = i.allow.length === 0 ? "any site that asks for payment over x402" : i.allow.length === 1 ? `only ${i.allow[0]}` : `only these sites: ${i.allow.join(", ")}`;
  const pace = i.perMinute === null ? "" : `, at most ${i.perMinute} payments a minute`;
  return `Your agent may pay ${where}. Never more than $${i.perPayment} at once, $${i.perSeller} to one seller in a day, or $${i.daily} in a day in total${pace}. It cannot change these limits: they are read before the conversation starts.`;
}

export interface Step {
  readonly title: string;
  readonly explain: string;
  readonly code: string;
  /** Where the code goes, when it is not a terminal. */
  readonly file?: string;
}

const env = (i: FactoryInput): Record<string, string> => ({ CRA_NETWORK: i.network, CRA_KEY_FILE: i.keyFile, CRA_POLICY: policyString(i) });
const shellEnv = (i: FactoryInput): string => Object.entries(env(i)).map(([k, v]) => `${k}='${v}'`).join(" ");

function clientStep(i: FactoryInput): Step {
  const json = JSON.stringify({ mcpServers: { "cra-agent": { command: "cra-agent-mcp", env: env(i) } } }, null, 2);
  switch (i.client) {
    case "claude-desktop":
      return { title: "Tell Claude about it", explain: "Open Claude, Settings, Developer, Edit Config, and put this in the file. If the file already lists other servers, add the cra-agent entry next to them. Then restart Claude.", code: json, file: "claude_desktop_config.json" };
    case "cursor":
      return { title: "Tell Cursor about it", explain: "Put this in the file below (create it if it is not there), then reload Cursor.", code: json, file: "~/.cursor/mcp.json" };
    case "claude-code":
      return { title: "Tell Claude Code about it", explain: "One command, run once, in the folder where you use Claude Code.", code: `claude mcp add cra-agent ${Object.entries(env(i)).map(([k, v]) => `-e ${k}='${v}'`).join(" ")} -- cra-agent-mcp` };
    case "terminal":
      return { title: "Set the limits for this terminal", explain: "No AI client: you drive the agent by hand with the cra-agent command. These three lines set its network, its key and its limits for the terminal you paste them in.", code: Object.entries(env(i)).map(([k, v]) => `export ${k}='${v}'`).join("\n") };
  }
}

export function steps(i: FactoryInput): Step[] {
  const dir = i.keyFile.replace(/[/\\][^/\\]*$/, "");
  const firstUrl = "https://api.cra-agent.tech/v1/paid/fx/execution?symbol=EURC";
  return [
    { title: "Install the agent", explain: "Needs Node 20 or newer. This installs two commands: cra-agent-mcp, which your AI client talks to, and cra-agent, for you.", code: "npm i -g @cra-agent/mcp" },
    {
      title: "Make the agent's key, on your machine",
      explain: "This creates a new wallet only the agent uses, and writes its key to a file only you can read. The key never leaves your machine: this page does not see it, and you should never paste it anywhere. If the file already exists the command leaves it alone.",
      code: `mkdir -p '${dir}' && { test -e '${i.keyFile}' && echo "there is already a key here, keeping it" || { (printf 0x; openssl rand -hex 32) > '${i.keyFile}' && chmod 600 '${i.keyFile}'; }; }`,
    },
    clientStep(i),
    {
      title: "Give it a little money",
      explain: `The first command prints the agent's address. Send a few dollars of USDC on ${i.network === "arc" ? "Arc mainnet" : "Arc testnet"} to that address, from your own wallet. The second command moves one dollar of it into Circle Gateway, which is where payments are made from. Keep it small: the agent can never spend more than what you put there.`,
      code: `${shellEnv(i)} cra-agent balance\n${shellEnv(i)} cra-agent deposit 1`,
    },
    i.client === "terminal"
      ? { title: "Make the first payment", explain: "The first line reads the price and says whether your limits allow it, without paying. The second pays and prints the data with its receipt.", code: `cra-agent quote '${firstUrl}'\ncra-agent pay '${firstUrl}'` }
      : { title: "Give it a first job", explain: "Paste this to your AI. It checks the price first, pays only if your limits allow it, and shows you the receipt.", code: `Use the cra-agent tools. First show me the spending policy in force. Then get a quote for ${firstUrl} and tell me the price and whether the policy allows it. If it does, pay for it, tell me the euro to dollar rate on Arc it returns, and show me the receipt.` },
  ];
}
