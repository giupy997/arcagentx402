/**
 * A plain x402 buyer that pays a route on one named network.
 *
 * Our own rail always picks Arc. This is for the other rail: a catalogue is filled by the
 * facilitator that settles a payment, so the resource has to be bought there at least once.
 *
 *   npx tsx scripts/pay-on-network.mts <url> [caip2 network]
 */
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";

const BASE = (process.argv[3] ?? "eip155:8453") as `${string}:${string}`;
const url = process.argv[2] ?? "https://api.cra-agent.tech/v1/paid/rpc/health";
const keyFile = process.env.CRA_KEY_FILE ?? ".secrets/agent.key";
const raw = readFileSync(keyFile, "utf8").trim();
const account = privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`);
console.log("buyer:", account.address, "\nresource:", url);

const pickBase = (_v: number, accepts: PaymentRequirements[]): PaymentRequirements => {
  const base = accepts.find((a) => a.network === BASE);
  if (!base) throw new Error(`no Base option offered; got ${accepts.map((a) => a.network).join(", ")}`);
  console.log("paying:", base.network, base.amount, "base units ->", base.payTo);
  return base;
};

const client = new x402Client(pickBase);
client.register(BASE, new ExactEvmScheme(account));
// A hard ceiling for this script: a cent, whatever the route claims to cost.
// Arc's USDC is not one of the SDK's default assets yet, so it has to be named, with its own cap in base units.
client.setSpendControls({ maxAmountPerPayment: "$0.01", allowedAssets: [{ network: "eip155:5042", asset: "0x3600000000000000000000000000000000000000", maxAmountPerPayment: 10_000n }] });

const paying = wrapFetchWithPayment(globalThis.fetch, client);
const res = await paying(url);
console.log("status:", res.status);
// When the second 402 comes back, the reason is in the challenge header, not the body.
const challenge = res.headers.get("payment-required");
if (challenge) {
  try {
    const d = JSON.parse(Buffer.from(challenge, "base64").toString());
    console.log("challenge error:", d.error, "| accepts:", d.accepts?.map((a: { network: string }) => a.network).join(", "));
  } catch { /* not base64 json */ }
}
const settle = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
if (settle) {
  try {
    console.log("settlement:", JSON.stringify(JSON.parse(Buffer.from(settle, "base64").toString()), null, 1).slice(0, 600));
  } catch {
    console.log("settlement header:", settle.slice(0, 200));
  }
}
console.log("body:", (await res.text()).slice(0, 300));
