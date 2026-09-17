/**
 * A real payment on Arc through Circle's Facilitator Service, using the keyless trial.
 *
 * Our Arc rail settles through Circle Gateway, which makes the buyer deposit first. This tries the
 * other shape: the buyer signs an EIP-3009 authorization straight from its wallet, and the seller
 * asks the facilitator to settle it. Run it to see whether that path works for us, and how long it
 * takes: npx tsx scripts/try-circle-facilitator.mts [amountBaseUnits]
 */
import { readFileSync } from "node:fs";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const FACILITATOR = "https://api.circle.com/v1/facilitator/x402";
const NETWORK = "eip155:5042";
const CHAIN_ID = 5042;
const USDC = "0x3600000000000000000000000000000000000000";
const amount = process.argv[2] ?? "500"; // $0.0005, our cheapest route

const key = (p: string) => {
  const raw = readFileSync(p, "utf8").trim();
  return privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`);
};
const buyer = key(process.env.BUYER_KEY_FILE ?? ".secrets/agent-testnet.key");
const seller = key(process.env.SELLER_KEY_FILE ?? ".secrets/seller-testnet.key");
console.log("buyer ", buyer.address, "\nseller", seller.address, "\namount", amount, "base units");

const accepted = {
  scheme: "exact",
  network: NETWORK,
  amount,
  asset: USDC,
  payTo: seller.address,
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" },
};

// The buyer authorises the transfer off chain. No gas, no deposit, no approval.
const validAfter = 0n;
const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600);
const nonce = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}` as `0x${string}`;
const authorization = { from: buyer.address, to: seller.address, value: BigInt(amount), validAfter, validBefore, nonce };
const signature = await buyer.signTypedData({
  domain: { name: "USDC", version: "2", chainId: CHAIN_ID, verifyingContract: USDC as `0x${string}` },
  types: {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  },
  primaryType: "TransferWithAuthorization",
  message: authorization,
});

const body = JSON.stringify({
  x402Version: 2,
  paymentPayload: {
    x402Version: 2,
    resource: { url: "https://api.cra-agent.tech/v1/paid/rpc/health", description: "Per-provider RPC latency and head lag", mimeType: "application/json" },
    accepted,
    payload: {
      signature,
      authorization: { from: authorization.from, to: authorization.to, value: amount, validAfter: validAfter.toString(), validBefore: validBefore.toString(), nonce },
    },
  },
  paymentRequirements: accepted,
});

/** The seller proves it controls payTo. One proof per call, bound to the body and the purpose. */
async function proof(purpose: "verify" | "settle" | "status", method: string, payload: string): Promise<string> {
  const n = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}` as `0x${string}`;
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 300;
  const sig = await seller.signTypedData({
    domain: { name: "Circle Facilitator Seller Request", version: "1", chainId: CHAIN_ID },
    types: {
      SellerRequest: [
        { name: "purpose", type: "string" },
        { name: "method", type: "string" },
        { name: "bodyHash", type: "bytes32" },
        { name: "network", type: "string" },
        { name: "payTo", type: "address" },
        { name: "nonce", type: "bytes32" },
        { name: "issuedAt", type: "uint64" },
        { name: "expiresAt", type: "uint64" },
      ],
    },
    primaryType: "SellerRequest",
    message: { purpose, method: method.toUpperCase(), bodyHash: keccak256(toBytes(payload)), network: NETWORK, payTo: seller.address, nonce: n, issuedAt: BigInt(issuedAt), expiresAt: BigInt(expiresAt) },
  });
  return Buffer.from(JSON.stringify({ version: 1, signature: sig, network: NETWORK, payTo: seller.address, nonce: n, issuedAt, expiresAt })).toString("base64url");
}

for (const purpose of ["verify", "settle"] as const) {
  const started = Date.now();
  const res = await fetch(`${FACILITATOR}/${purpose}`, {
    method: "POST",
    headers: { "content-type": "application/json", "Facilitator-Seller-Proof": await proof(purpose, "POST", body) },
    body,
  });
  const text = await res.text();
  console.log(`\n${purpose}: HTTP ${res.status} in ${Date.now() - started} ms`);
  console.log(text.slice(0, 700));
  if (!res.ok) break;
}
