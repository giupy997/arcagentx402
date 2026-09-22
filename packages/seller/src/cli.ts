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
 *   --facilitator <url>     settle directly through this x402 facilitator instead of Circle Gateway
 *   --list <public-url>     once running, add this public URL to the CRA marketplace
 *
 * Payments go through Circle Gateway: the money lands in the Gateway balance of --pay-to, from
 * where its owner withdraws it. This process never holds a key.
 */
import { serve } from "@hono/node-server";
import { createProxyApp } from "./proxy.js";
import { parseSellArgs } from "./sell-args.js";

const MARKET = process.env.CRA_MARKET_URL ?? "https://api.cra-agent.tech/v1/market";

async function addToMarket(url: string): Promise<void> {
  try {
    const res = await fetch(MARKET, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }), signal: AbortSignal.timeout(20_000) });
    const body = (await res.json().catch(() => ({}))) as { error?: string; listing?: { url: string } };
    console.log(res.ok ? `Listed on the marketplace: https://cra-agent.tech/market` : `Not listed: ${body.error ?? `HTTP ${res.status}`}`);
  } catch (err) {
    console.log(`Not listed: could not reach the marketplace (${(err as Error).message}). Add it by hand at https://cra-agent.tech/market`);
  }
}

function main(): void {
  const a = parseSellArgs(process.argv.slice(2));
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
    onSettlement: (e) => console.log(`${new Date().toISOString()} ${e.outcome} ${(Number(e.amount) / 1e6).toFixed(6)} USDC from ${e.payer ?? "unknown"}${e.transaction ? ` (${e.transaction})` : ""}${e.reason ? `: ${e.reason}` : ""}`),
  });
  // Behind a TLS proxy the request arrives as http, and the 402 would advertise an http URL buyers cannot use.
  const fetchWithRealScheme: typeof app.fetch = (request, ...rest) => {
    const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    if (proto !== "https" || !request.url.startsWith("http://")) return app.fetch(request, ...rest);
    return app.fetch(new Request(`https://${request.url.slice("http://".length)}`, request), ...rest);
  };
  serve({ fetch: fetchWithRealScheme, port: a.port }, () => {
    console.log(`Selling ${a.target} on http://localhost:${a.port}`);
    for (const r of a.routes) console.log(`  ${r.pattern.padEnd(28)} ${r.price} per call`);
    for (const f of a.free) console.log(`  ${f.padEnd(28)} free`);
    if (a.payToSolana) console.log(`Also for sale on Solana, paid to ${a.payToSolana} there.`);
    console.log(`Paid to ${a.payTo} on ${a.network === "arc" ? "Arc mainnet" : "Arc testnet"}, settled ${a.facilitatorUrl ? `by ${a.facilitatorUrl}` : "through Circle Gateway"}.`);
    console.log(`What is for sale, for anyone to read: http://localhost:${a.port}/.well-known/x402`);
    console.log("Buyers need a public https address in front of this port. Once you have one, add it to the marketplace with --list <url>.");
    if (a.list) void addToMarket(a.list);
  });
}

try {
  main();
} catch (err) {
  console.error(`cra-agent-sell: ${(err as Error).message}`);
  process.exit(1);
}
