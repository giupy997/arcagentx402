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

/**
 * The whole setup as one line for a terminal. `cra-agent init` runs on the visitor's machine: it
 * makes the key there, writes the client's config with a copy of the old one, and prints the
 * address to fund. The key path is left to it unless the visitor changed the default.
 */
export function oneCommand(i: FactoryInput, defaultKeyFile: string): Step {
  const keyFlag = i.keyFile === defaultKeyFile ? "" : ` --key-file '${i.keyFile}'`;
  const where = i.client === "claude-desktop" ? "writes the entry into Claude's config file and keeps a copy of the old one" : i.client === "cursor" ? "writes the entry into Cursor's config file and keeps a copy of the old one" : i.client === "claude-code" ? "prints the one command that adds it to Claude Code" : "prints the three lines that set up your terminal";
  return {
    title: "Paste this in a terminal",
    explain: `Needs Node 20 or newer. It installs the agent, creates its key on your machine in a file only you can read, checks the limits, ${where}, and tells you the address to send money to. If a key is already there it keeps it.`,
    code: `npm i -g @cra-agent/mcp && cra-agent init --client ${i.client} --network ${i.network} --policy '${policyString(i)}'${keyFlag}`,
  };
}

export function steps(i: FactoryInput): Step[] {
  const dir = i.keyFile.replace(/[/\\][^/\\]*$/, "");
  const firstUrl = "https://api.cra-agent.tech/v1/paid/market/prices";
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
      ? { title: "Make the first payment", explain: "The first line searches what is for sale on Arc and says which results your limits allow. The second reads the price without paying. The third pays and prints the data with its receipt.", code: `cra-agent find bitcoin price\ncra-agent quote '${firstUrl}'\ncra-agent pay '${firstUrl}'` }
      : { title: "Give it a first job", explain: "Paste this to your AI. It searches what is for sale on Arc, picks what your limits allow, checks the price, pays, and shows you the receipt. Nobody tells it the address: it finds it.", code: "Use the cra-agent tools. Find the price of Bitcoin on Arc: search for it, pick the cheapest result my spending policy allows, quote it, pay for it, then tell me the price and show me the receipt." },
  ];
}

/* ------------------------------------------------------------------ selling */

export interface SellInput {
  /** The API that already exists. */
  readonly target: string;
  /** The wallet that gets paid. */
  readonly payTo: string;
  /** A Solana address, when the seller wants Solana buyers too. Empty otherwise. */
  readonly payToSolana: string;
  /** Where, on the seller's machine, a file holds their node's receive-only NWC connection: sats too. Empty otherwise. */
  readonly lightningFile: string;
  /** Lightning proofs checked and remembered by the CRA facilitator instead of a file on the seller's machine. */
  readonly lightningFacilitator: boolean;
  /** Dollars per call, as typed. */
  readonly price: string;
  readonly name: string;
  /** Paths served without payment, as typed: one per line. */
  readonly free: readonly string[];
  readonly network: Network;
  /** The public https address buyers will call, when the seller already has one. */
  readonly publicUrl: string;
  /** Settle through our facilitator, so browser wallets can pay. Needs the wallet registered. */
  readonly browserWallets: boolean;
}

export function sellProblems(i: SellInput): string[] {
  const out: string[] = [];
  if (!/^https?:\/\/[^\s'"`$]+$/i.test(i.target)) out.push("The address of your API must start with http:// or https://, with no spaces or quotes.");
  if (!/^0x[0-9a-fA-F]{40}$/.test(i.payTo)) out.push("The wallet is a 0x address, 42 characters long. Paste it from your wallet.");
  if (i.payToSolana && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(i.payToSolana)) out.push("The Solana address does not look like one. Paste it from your Solana wallet, or leave it empty.");
  // The connection is a secret: it never goes in a command, only the path of the file that holds it.
  if (/^nostr\+walletconnect:/i.test(i.lightningFile)) out.push("Do not paste the Lightning connection here: it is a secret. Save it in a file on the machine that runs the command, readable only by you, and write that file's path.");
  else if (i.lightningFile && !/^\.{0,2}\/[^\s'"`$\\]+$/.test(i.lightningFile)) out.push("The Lightning file is a path on your machine, like /home/you/.secrets/nwc-receive: starting with / or ./, with no spaces, quotes or ~.");
  if (!AMOUNT.test(i.price) || Number(i.price) <= 0) out.push("The price must be an amount in dollars, like 0.002.");
  if (/['"`$\\]/.test(i.name)) out.push("The name cannot contain quotes, backticks, dollar signs or backslashes.");
  for (const f of i.free) if (!/^\/[^\s'"`$]*$/.test(f)) out.push(`\u201c${f}\u201d is not a path. Write it like /health.`);
  if (i.publicUrl && !/^https:\/\/[^\s'"`$]+$/i.test(i.publicUrl)) out.push("The public address must start with https://. Leave it empty if you do not have one yet.");
  return out;
}

/** The one line that starts selling. Every value is single-quoted, and the checks above keep quotes out of them. */
export function sellCommand(i: SellInput): Step {
  const parts = [`npx -y @cra-agent/seller --target '${i.target}' --pay-to ${i.payTo} --price ${i.price}`];
  if (i.payToSolana) parts.push(`--pay-to-solana ${i.payToSolana}`);
  if (i.lightningFile) parts.push(`--pay-to-lightning '${i.lightningFile}'`);
  if (i.lightningFile && i.lightningFacilitator) parts.push("--lightning-facilitator cra");
  if (i.name) parts.push(`--name '${i.name}'`);
  for (const f of i.free) parts.push(`--free '${f}'`);
  if (i.network !== "arc") parts.push(`--network ${i.network}`);
  if (i.browserWallets) parts.push("--facilitator cra");
  if (i.publicUrl) parts.push(`--list '${i.publicUrl}'`);
  return {
    title: "Run this where your API runs",
    explain: `Needs Node 20 or newer. It starts a small server on port 8402 that stands in front of your API: a caller who has not paid gets the price, a caller who has paid gets your API's answer, untouched. Your code does not change, and this process never holds a key. A call your API fails is not charged${i.lightningFile ? " in USDC; in sats the payment comes first, as Lightning's x402 scheme has it, so a failed call is still paid" : ""}.${i.lightningFile ? " With Lightning it reaches your node before it starts, and stops if the connection is wrong." : ""}${i.publicUrl ? " Once it is up, it adds your public address to the market." : ""}`,
    code: parts.join(" "),
  };
}

export function sellInWords(i: SellInput): string {
  const free = i.free.length ? ` These paths stay free: ${i.free.join(", ")}.` : "";
  const browser = i.browserWallets ? " Browser wallets can pay too, settled by the CRA facilitator, once the wallet is registered." : "";
  const solana = i.payToSolana ? ` Buyers on Solana can pay too, in USDC on Solana, to ${i.payToSolana.slice(0, 4)}\u2026${i.payToSolana.slice(-4)}.` : "";
  const sats = i.lightningFile ? " Buyers with bitcoin can pay in sats over Lightning, straight to your node: the same price in dollars, turned into sats at the rate of the moment, at least 1 sat." : "";
  return `Every call to ${i.name || "your API"} will cost $${i.price}, paid in USDC on ${i.network === "arc" ? "Arc mainnet" : "Arc testnet"} to ${i.payTo.slice(0, 6)}\u2026${i.payTo.slice(-4)}.${free}${browser}${solana}${sats} Buyers are AI agents (ours or any x402 client). The money lands in the Circle Gateway balance of that wallet: you collect it with one command, shown below.`;
}

export function sellNextSteps(i: SellInput): Step[] {
  return [
    ...(i.lightningFile
      ? [{
          title: "Before you start: the connection to your Lightning node",
          explain: `In Alby Hub, open Connections, add a connection and give it the Read Only permissions: it can create invoices and read your node's key, never pay. Copy the connection string into the file named in the command, with your editor, so it does not end up in your shell history; the first line makes the file readable only by you. Your node needs inbound capacity to receive, a channel bought from an LSP, and must sign invoices with a description hash: Alby Hub on its default LDK backend does. ${i.lightningFacilitator ? "Each payment is checked by the CRA facilitator, which remembers its proof so it cannot be used twice: keep that choice for this node." : "Settled payments are remembered in ~/.cra-agent/lnbtc-replay.jsonl, so a proof cannot be used twice, even after a restart."}`,
          code: `install -m 600 /dev/null '${i.lightningFile}'\nnano '${i.lightningFile}'`,
        }]
      : []),
    ...(i.browserWallets
      ? [{ title: "Register the wallet that gets paid", explain: "Once, with the wallet you gave as --pay-to: connect it on the page below and sign a message. No transaction, nothing moves. Until it is registered, the facilitator refuses payments to it and the command tells you so at start.", code: "https://cra-agent.tech/register" }]
      : []),
    {
      title: "Give it a public https address",
      explain: "Buyers cannot reach port 8402 on your machine. Point your usual reverse proxy at it, the same way you publish your API today. With Caddy that is two lines; nginx, Cloudflare or a platform's router do the same. To try it for ten minutes without any of that, a tunnel works too.",
      code: "pay.example.com {\n  reverse_proxy localhost:8402\n}",
      file: "Caddyfile (example)",
    },
    {
      title: "Check it as a buyer would",
      explain: "The first line shows what is for sale. The second must answer 402 Payment Required: that is the price tag. If you installed the agent, the third pays for a call and shows the receipt.",
      code: `curl ${i.publicUrl || "https://pay.example.com"}/.well-known/x402\ncurl -i ${i.publicUrl || "https://pay.example.com"}/\ncra-agent pay '${i.publicUrl || "https://pay.example.com"}/'`,
    },
    {
      title: "Collect what you earned",
      explain: "Payments are batched by Circle Gateway, so they add up in the Gateway balance of your wallet instead of arriving one by one. The first line shows that balance, the second moves an amount back to the wallet itself. Both need the key of that wallet in a file on your machine, readable only by you, which is why a wallet made for this is better than your main one. Circle may take a fee on a withdrawal: the command refuses to pay more than 5 cents unless you tell it otherwise.",
      code: `npm i -g @cra-agent/mcp\nCRA_NETWORK=${i.network} CRA_KEY_FILE=/full/path/to/seller.key cra-agent balance\nCRA_NETWORK=${i.network} CRA_KEY_FILE=/full/path/to/seller.key cra-agent withdraw 1`,
    },
  ];
}
