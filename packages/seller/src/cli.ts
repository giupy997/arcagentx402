#!/usr/bin/env node
/**
 * cra-agent-sell: put a price on an API you already run, without touching its code.
 *
 *   npx @cra-agent/seller --target https://api.example.com --pay-to 0xYourWallet --price 0.002
 *
 *   --target <url>          the API to sell (required)
 *   --pay-to <address>      the wallet that gets paid, on Arc (required)
 *   --pay-to-solana <addr>  also sell to buyers on Solana, paid on this Solana address
 *   --price <usd>           price of every call, like 0.002
 *   --route "<pat>=<usd>"   price of one path, repeatable: --route "GET /v1/forecast=0.002" --route "/v1/render/*=0.05"
 *   --free <pattern>        a path served without payment, repeatable: --free /health
 *   --name, --description   shown to buyers and in directories
 *   --network <n>           arc (default) or arcTestnet
 *   --port <n>              default 8402
 *   --upstream-header "Name: value"   added to requests sent to your API, repeatable (e.g. its own key)
 *   --facilitator <url|cra> settle directly through this x402 facilitator instead of Circle Gateway; "cra" is
 *                           ours: browser wallets can then pay, after --pay-to registers at cra-agent.tech/register
 *   --list <public-url>     once running, add this public URL to the CRA marketplace
 *   --pay-to-lightning <file>  also sell in sats over Lightning, paid to your own node: the file holds
 *                           a receive-only Nostr Wallet Connect string (Alby Hub: a connection with the
 *                           Read Only permissions). Settled proofs are remembered in
 *                           ~/.cra-agent/lnbtc-replay.jsonl (or CRA_LNBTC_REPLAY_FILE).
 *   --lightning-facilitator <url|cra>  check and remember Lightning proofs at this x402 facilitator
 *                           instead of on this machine; "cra" is ours, open to anyone, no registration.
 *                           Keep the same choice for a node: the two places do not know each other's proofs.
 *
 * Payments go through Circle Gateway: the money lands in the Gateway balance of --pay-to, from
 * where its owner withdraws it. Sats land on the seller's node. This process never holds a key.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { btcUsdRate, FileReplayStore, lnbtcFacilitatorClient, lnbtcNetwork, nwcReceiver, readConnection } from "@cra-agent/lightning";
import { createProxyApp, type LightningSale } from "./proxy.js";
import { parseSellArgs } from "./sell-args.js";

const MARKET = process.env.CRA_MARKET_URL ?? "https://api.cra-agent.tech/v1/market";

/** Our facilitator settles only for wallets that registered: say so before the first buyer finds out. */
async function checkRegistered(payTo: string, facilitatorUrl: string): Promise<void> {
  try {
    const api = facilitatorUrl.replace(/\/facilitator\/?$/, "");
    const s = (await (await fetch(`${api}/v1/facilitator/sellers/${payTo}`, { signal: AbortSignal.timeout(10_000) })).json()) as { registered?: boolean; settledToday?: number; dailyCap?: number | null };
    if (s.registered) console.log(`Facilitator: ${payTo} is registered${s.dailyCap ? ` (${s.settledToday ?? 0}/${s.dailyCap} settlements used today)` : ""}.`);
    else console.log(`Facilitator: ${payTo} is NOT registered yet. Payments will be refused until it is: sign once at https://cra-agent.tech/register with that wallet.`);
  } catch {
    console.log("Facilitator: could not check whether the wallet is registered. Make sure it is, at https://cra-agent.tech/register");
  }
}

async function addToMarket(url: string): Promise<void> {
  try {
    const res = await fetch(MARKET, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }), signal: AbortSignal.timeout(20_000) });
    const body = (await res.json().catch(() => ({}))) as { error?: string; listing?: { url: string } };
    console.log(res.ok ? `Listed on the marketplace: https://cra-agent.tech/market` : `Not listed: ${body.error ?? `HTTP ${res.status}`}`);
  } catch (err) {
    console.log(`Not listed: could not reach the marketplace (${(err as Error).message}). Add it by hand at https://cra-agent.tech/market`);
  }
}

/** The seller's node, reached once before the first buyer: a wrong connection should stop the start, not a sale. */
async function lightningSale(file: string, facilitatorUrl: string | undefined): Promise<LightningSale> {
  const receiver = await nwcReceiver(readConnection(file));
  const network = lnbtcNetwork(receiver.nodeNetwork);
  // Proofs are claimed in one place for a node. Falling back to this machine when the facilitator is down at start
  // would split them across two stores that cannot see each other, so it stops instead.
  const facilitator = facilitatorUrl ? lnbtcFacilitatorClient(facilitatorUrl) : null;
  if (facilitator && !(await facilitator.supports(network))) throw new Error(`${facilitator.url} does not list exact on ${network}, or did not answer. Start again when it does, or leave --lightning-facilitator out to check proofs on this machine.`);
  return {
    receiver,
    network,
    ...(facilitator ? { facilitator } : { replay: new FileReplayStore(process.env.CRA_LNBTC_REPLAY_FILE ?? join(homedir(), ".cra-agent", "lnbtc-replay.jsonl")) }),
    rate: btcUsdRate(),
    onSettled: (e) => console.log(`${new Date().toISOString()} settled ${e.amountMsat} msat over Lightning for ${e.resource} (${e.paymentHash}); your API answered ${e.status}`),
  };
}

async function main(): Promise<void> {
  const a = parseSellArgs(process.argv.slice(2));
  const lightning = a.payToLightning ? await lightningSale(a.payToLightning, a.lightningFacilitatorUrl) : undefined;
  const app = createProxyApp({
    target: a.target,
    payTo: a.payTo,
    ...(a.payToSolana ? { payToSolana: a.payToSolana } : {}),
    network: a.network,
    routes: a.routes,
    free: a.free,
    upstreamHeaders: a.upstreamHeaders,
    ...(a.name ? { name: a.name } : {}),
    ...(a.description ? { description: a.description } : {}),
    ...(a.facilitatorUrl ? { facilitatorUrl: a.facilitatorUrl } : {}),
    ...(lightning ? { lightning } : {}),
    onSettlement: (e) => console.log(`${new Date().toISOString()} ${e.outcome} ${(Number(e.amount) / 1e6).toFixed(6)} USDC from ${e.payer ?? "unknown"}${e.transaction ? ` (${e.transaction})` : ""}${e.reason ? `: ${e.reason}` : ""}`),
  });
  // Behind a TLS proxy the request arrives as http, and the 402 would advertise an http URL buyers cannot use.
  // A Lightning invoice is bound to the URL the buyer called, so the host they called counts too.
  const fetchWithRealScheme: typeof app.fetch = (request, ...rest) => {
    const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
    const url = new URL(request.url);
    const secure = proto === "https" && url.protocol === "http:";
    const moved = !!host && /^[a-z0-9.-]+(:\d+)?$/i.test(host) && host.toLowerCase() !== url.host.toLowerCase();
    if (!secure && !moved) return app.fetch(request, ...rest);
    const scheme = secure ? "https:" : url.protocol;
    const rawPath = request.url.slice(request.url.indexOf("/", request.url.indexOf("//") + 2));
    return app.fetch(new Request(`${scheme}//${moved ? host : url.host}${rawPath}`, request), ...rest);
  };
  serve({ fetch: fetchWithRealScheme, port: a.port }, () => {
    console.log(`Selling ${a.target} on http://localhost:${a.port}`);
    for (const r of a.routes) console.log(`  ${r.pattern.padEnd(28)} ${r.price} per call`);
    for (const f of a.free) console.log(`  ${f.padEnd(28)} free`);
    if (a.payToSolana) console.log(`Also for sale on Solana, paid to ${a.payToSolana} there.`);
    if (lightning) console.log(`Also for sale in sats over Lightning, paid to your node ${lightning.receiver.pubkey}. Proofs are checked and remembered ${lightning.facilitator ? `by ${lightning.facilitator.url}` : `here, in ${(lightning.replay as FileReplayStore).path}`}.`);
    console.log(`Paid to ${a.payTo} on ${a.network === "arc" ? "Arc mainnet" : "Arc testnet"}, settled ${a.facilitatorUrl ? `by ${a.facilitatorUrl}` : "through Circle Gateway"}.`);
    console.log(`What is for sale, for anyone to read: http://localhost:${a.port}/.well-known/x402`);
    console.log("Buyers need a public https address in front of this port. Once you have one, add it to the marketplace with --list <url>.");
    if (a.facilitatorUrl?.includes("cra-agent.tech")) void checkRegistered(a.payTo, a.facilitatorUrl);
    if (a.list) void addToMarket(a.list);
  });
}

main().catch((err: unknown) => {
  console.error(`cra-agent-sell: ${(err as Error).message}`);
  process.exit(1);
});
