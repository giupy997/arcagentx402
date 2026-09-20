/**
 * The exact sequence packages/web/src/try.ts runs in a browser, with a key file standing in for the
 * wallet. Same hand-built typed data, same hand-built header, same CORS origin, so a change that
 * would break the page breaks this first: npx tsx scripts/simulate-browser-pay.mts [path]
 */
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";

const API = "https://api.cra-agent.tech";
const path = process.argv[2] ?? "/v1/direct/fx/execution?window=60&symbol=EURC";
const raw = readFileSync(process.env.CRA_KEY_FILE ?? ".secrets/agent-testnet.key", "utf8").trim();
const account = privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`);
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const browser = { accept: "application/json", origin: "https://cra-agent.tech" };

const started = Date.now();
const first = await fetch(`${API}${path}`, { headers: browser });
console.log("1st:", first.status, "| exposed to JS:", first.headers.get("access-control-expose-headers"));
const required = JSON.parse(Buffer.from(first.headers.get("PAYMENT-REQUIRED")!, "base64").toString());
const accept = required.accepts.find((a: { network: string; scheme: string }) => a.network === "eip155:5042" && a.scheme === "exact");
console.log("asks:", Number(accept.amount) / 1e6, "USDC ->", accept.payTo, "| domain", accept.extra.name, accept.extra.version, "| valid", accept.maxTimeoutSeconds, "s");

const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}` as `0x${string}`;
const authorization = { from: account.address, to: accept.payTo, value: accept.amount, validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + accept.maxTimeoutSeconds), nonce };
// What eth_signTypedData_v4 signs for the page's JSON.
const signature = await account.signTypedData({
  domain: { name: accept.extra.name, version: accept.extra.version, chainId: 5042, verifyingContract: accept.asset },
  types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
  primaryType: "TransferWithAuthorization",
  message: { from: account.address, to: accept.payTo, value: BigInt(accept.amount), validAfter: 0n, validBefore: BigInt(authorization.validBefore), nonce },
});
const payload = { x402Version: required.x402Version, resource: required.resource, accepted: accept, payload: { authorization, signature }, ...(required.extensions ? { extensions: required.extensions } : {}) };
const second = await fetch(`${API}${path}`, { headers: { ...browser, "PAYMENT-SIGNATURE": b64(JSON.stringify(payload)) } });
const settleHeader = second.headers.get("PAYMENT-RESPONSE");
console.log("2nd:", second.status, "in", ((Date.now() - started) / 1000).toFixed(1), "s");
console.log("settlement:", settleHeader ? Buffer.from(settleHeader, "base64").toString() : "(none)");
console.log("body:", (await second.text()).slice(0, 160));
