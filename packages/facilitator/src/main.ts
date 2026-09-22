#!/usr/bin/env node
/**
 * Runs the private facilitator. It listens on localhost only: the resource server next to it is
 * its one client, and nothing outside the machine can reach it.
 *
 *   FACILITATOR_KEY_FILE   file with the key that pays gas (chmod 600)
 *   FACILITATOR_PAY_TO     comma-separated payout addresses it settles for
 *   FACILITATOR_NETWORK    arc | arcTestnet (default arc)
 *   FACILITATOR_PORT       default 8792
 *   FACILITATOR_MAX_USDC   largest payment it will settle, default 1
 *   FACILITATOR_RPC_URL    optional, comma-separated, tried before the public endpoints
 *   FACILITATOR_SELLERS_FILE  where registered sellers are kept; registration is off without it
 *   FACILITATOR_DAILY_CAP  settlements a registered seller gets per UTC day, default 200
 */
import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { parseUsdc6, usdc6 } from "@cra-agent/accounting";
import { CAIP2, CHAINS, CHAIN_IDS, PUBLIC_RPCS, mergeRpcLists, parseRpcList, pickRpcUrl, redactRpcUrl, type ArcNetwork } from "@cra-agent/identity";
import type { Hex } from "viem";
import { createFacilitator } from "./index.js";
import { SellerRegistry } from "./sellers.js";

const ARC_USDC = "0x3600000000000000000000000000000000000000";
const env = process.env;
const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), app: "cra-agent-facilitator", event, ...data }));

const network = (env.FACILITATOR_NETWORK ?? "arc") as ArcNetwork;
if (network !== "arc" && network !== "arcTestnet") throw new Error("FACILITATOR_NETWORK must be arc or arcTestnet");
if (!env.FACILITATOR_KEY_FILE) throw new Error("FACILITATOR_KEY_FILE is required: a chmod 600 file with the key that pays gas");
const payTo = new Set(parseRpcList(env.FACILITATOR_PAY_TO).map((a) => a.toLowerCase()));
if (payTo.size === 0) throw new Error("FACILITATOR_PAY_TO is required: this facilitator only settles for addresses it is told about");
for (const a of payTo) if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error(`FACILITATOR_PAY_TO: ${a} is not an address`);

const raw = readFileSync(env.FACILITATOR_KEY_FILE, "utf8").trim();
const privateKey = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
const rpcUrl = await pickRpcUrl(mergeRpcLists(parseRpcList(env.FACILITATOR_RPC_URL), PUBLIC_RPCS[network]), CHAIN_IDS[network]);

const sellers = env.FACILITATOR_SELLERS_FILE ? new SellerRegistry(env.FACILITATOR_SELLERS_FILE, Number(env.FACILITATOR_DAILY_CAP ?? 200)) : undefined;
if (sellers && !(sellers.dailyCap >= 1)) throw new Error("FACILITATOR_DAILY_CAP must be a number of settlements per day");

const { app, address } = createFacilitator({
  chain: CHAINS[network],
  network: CAIP2[network],
  rpcUrl,
  privateKey,
  rules: { payTo, assets: new Map([[CAIP2[network], ARC_USDC]]), minAmount: usdc6(1n), maxAmount: parseUsdc6(env.FACILITATOR_MAX_USDC ?? "1"), ...(sellers ? { registered: sellers } : {}) },
  ...(sellers ? { sellers } : {}),
  log,
});

const port = Number(env.FACILITATOR_PORT ?? 8792);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => log("listening", { port, host: "127.0.0.1", signer: address, network: CAIP2[network], rpc: redactRpcUrl(rpcUrl), settlesFor: [...payTo], registeredSellers: sellers?.size ?? 0, dailyCap: sellers?.dailyCap ?? null }));
