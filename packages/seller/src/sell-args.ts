/** The command line of cra-agent-sell, apart from the process that serves, so it can be tested. */
import { normalisePrice, parseRouteFlag, type PricedPath } from "./proxy.js";

export interface SellArgs {
  target: string;
  payTo: string;
  payToSolana?: string;
  /** A file holding the seller's receive-only Nostr Wallet Connect string: also sell in sats, paid to that node. */
  payToLightning?: string;
  /** Where Lightning proofs are checked and remembered, when not on this machine: an x402 facilitator that settles lnbtc. */
  lightningFacilitatorUrl?: string;
  network: "arc" | "arcTestnet";
  port: number;
  routes: PricedPath[];
  free: string[];
  name?: string;
  description?: string;
  upstreamHeaders: Record<string, string>;
  facilitatorUrl?: string;
  list?: string;
  /** Bill by use: each price is a ceiling, and the API reports what a call cost. */
  upto: boolean;
}

export function parseSellArgs(argv: readonly string[]): SellArgs {
  const many = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "proxy" && i === 0) continue; // `npx @cra-agent/seller proxy …` reads naturally; the word is optional
    if (a === "--upto") {
      many.set("upto", ["yes"]); // the one option that takes no value
      continue;
    }
    if (!a.startsWith("--")) throw new Error(`unexpected "${a}"`);
    const eq = a.indexOf("=");
    const [key, value] = eq > 0 && !a.startsWith("--route") && !a.startsWith("--upstream-header") ? [a.slice(2, eq), a.slice(eq + 1)] : [a.slice(2), argv[++i] ?? ""];
    many.set(key, [...(many.get(key) ?? []), value]);
  }
  const known = ["target", "pay-to", "pay-to-solana", "pay-to-lightning", "lightning-facilitator", "price", "route", "free", "name", "description", "network", "port", "upstream-header", "facilitator", "list", "upto"];
  for (const k of many.keys()) if (!known.includes(k)) throw new Error(`unknown option --${k}`);
  const one = (k: string): string | undefined => many.get(k)?.at(-1);

  const target = one("target");
  if (!target || !/^https?:\/\/\S+$/i.test(target)) throw new Error("--target is required: the URL of the API to sell, like https://api.example.com");
  const payTo = one("pay-to");
  if (!payTo || !/^0x[0-9a-fA-F]{40}$/.test(payTo)) throw new Error("--pay-to is required: the 0x address that gets paid");
  const payToSolana = one("pay-to-solana");
  if (payToSolana && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(payToSolana)) throw new Error("--pay-to-solana is a Solana address");
  const payToLightning = one("pay-to-lightning");
  if (payToLightning !== undefined && !payToLightning.trim()) throw new Error("--pay-to-lightning takes the path of a file that holds your node's receive-only NWC connection");
  // Anyone on the machine can read a command line: the connection stays in a file only its owner can read.
  if (payToLightning?.startsWith("nostr+walletconnect:")) throw new Error("--pay-to-lightning takes a file path, not the connection itself: put the nostr+walletconnect:// string in a file only you can read (chmod 600) and give its path");
  const network = one("network") ?? "arc";
  if (network !== "arc" && network !== "arcTestnet") throw new Error("--network is arc or arcTestnet");
  const port = Number(one("port") ?? 8402);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port is a number between 1 and 65535");

  // Specific paths first: the first pattern that matches a request sets its price.
  const routes = (many.get("route") ?? []).map(parseRouteFlag);
  const price = one("price");
  if (price) routes.push({ pattern: "/*", price: normalisePrice(price) });
  if (routes.length === 0) throw new Error("give a price: --price 0.002 for every call, or --route \"GET /v1/x=0.002\" for one path");

  const upstreamHeaders: Record<string, string> = {};
  for (const h of many.get("upstream-header") ?? []) {
    const colon = h.indexOf(":");
    if (colon < 1) throw new Error(`--upstream-header "${h}": expected "Name: value"`);
    upstreamHeaders[h.slice(0, colon).trim()] = h.slice(colon + 1).trim();
  }
  // "cra" is our facilitator: it settles for registered wallets on Arc and lets browser wallets pay.
  const facilitatorUrl = one("facilitator") === "cra" ? "https://api.cra-agent.tech/facilitator" : one("facilitator");
  const lnf = one("lightning-facilitator");
  if (lnf !== undefined && !payToLightning) throw new Error("--lightning-facilitator goes with --pay-to-lightning");
  if (lnf !== undefined && lnf !== "cra" && !/^https:\/\/\S+$/i.test(lnf)) throw new Error("--lightning-facilitator takes cra or the https URL of an x402 facilitator that settles lnbtc");
  const lightningFacilitatorUrl = lnf === "cra" ? "https://api.cra-agent.tech/facilitator" : lnf;
  const list = one("list");
  if (list && !/^https:\/\/\S+$/i.test(list)) throw new Error("--list takes the public https URL buyers will call");
  const name = one("name");
  const description = one("description");
  const upto = many.has("upto");
  if (upto && !facilitatorUrl) throw new Error("--upto needs a facilitator that settles upto on Arc: add --facilitator cra (and register --pay-to at cra-agent.tech/register)");
  if (upto && (payToSolana || payToLightning)) throw new Error("--upto bills by use on Arc only: Solana and Lightning sell set prices. Leave --pay-to-solana and --pay-to-lightning out, or run them in a second paywall");
  return { target, payTo, network, port, routes, upto, free: many.get("free") ?? [], upstreamHeaders, ...(payToSolana ? { payToSolana } : {}), ...(payToLightning ? { payToLightning } : {}), ...(lightningFacilitatorUrl ? { lightningFacilitatorUrl } : {}), ...(name ? { name } : {}), ...(description ? { description } : {}), ...(facilitatorUrl ? { facilitatorUrl } : {}), ...(list ? { list } : {}) };
}

export interface SweepArgs {
  solanaKeyFile: string;
  to: string;
  /** Micro-USDC; everything in the wallet when absent. */
  amount?: bigint;
  /** Micro-USDC. */
  maxFee?: bigint;
  dryRun: boolean;
}

const microUsdc = (flag: string, v: string): bigint => {
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(v)) throw new Error(`${flag} is an amount in USDC, like 1.5`);
  const [whole, frac = ""] = v.split(".");
  return BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
};

/** `cra-agent-sell sweep`: move USDC earned on Solana to the seller's wallet on Arc. */
export function parseSweepArgs(argv: readonly string[]): SweepArgs {
  const one = new Map<string, string>();
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (!["--solana-key-file", "--to", "--amount", "--max-fee"].includes(a)) throw new Error(`unknown option ${a}`);
    const v = argv[++i];
    if (v === undefined) throw new Error(`${a} needs a value`);
    one.set(a.slice(2), v);
  }
  const solanaKeyFile = one.get("solana-key-file");
  if (!solanaKeyFile) throw new Error("--solana-key-file is required: the file with the Solana wallet's key, the one given as --pay-to-solana");
  const to = one.get("to");
  if (!to || !/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error("--to is required: the 0x address on Arc that receives the USDC");
  const amount = one.has("amount") ? microUsdc("--amount", one.get("amount")!) : undefined;
  if (amount === 0n) throw new Error("--amount must be more than 0");
  const maxFee = one.has("max-fee") ? microUsdc("--max-fee", one.get("max-fee")!) : undefined;
  return { solanaKeyFile, to, dryRun, ...(amount === undefined ? {} : { amount }), ...(maxFee === undefined ? {} : { maxFee }) };
}
