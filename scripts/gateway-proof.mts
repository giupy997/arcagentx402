import { readFileSync } from "node:fs";
import { GatewayClient } from "@circle-fin/x402-batching/client";

/** Ask Circle Gateway which on-chain transfer carried a settled payment: npx tsx scripts/gateway-proof.mts <transferId…> */
const raw = readFileSync("/Users/wayne/scritps/arc-rail/.secrets/agent-testnet.key", "utf8").trim();
const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
const rpcUrl = process.env.ARC_RPC_URL ?? "https://rpc.blockdaemon.mainnet.arc.io";
const gw = new GatewayClient({ chain: "arc", privateKey: key, rpcUrl });
for (const id of process.argv.slice(2)) {
  const t = (await gw.getTransferById(id)) as { status?: string; txHash?: string; updatedAt?: string; amount?: string };
  console.log(id, "->", JSON.stringify({ status: t?.status, txHash: t?.txHash, updatedAt: t?.updatedAt, amount: t?.amount }));
}
