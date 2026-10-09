/**
 * The sample receipt on cra-agent.tech/verify: signed twice by keys made here and thrown away, with no wallet
 * and no payment behind it. Its status says "sample" so nobody takes it for a payment.
 *
 *   npx tsx scripts/sample-receipt.mts > packages/web/public/receipt-sample.json
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { coSignSpendReceipt, newPostQuantumSeed, policyHash, postQuantumKey, signKeyStatement, spendReceiptDomain, SPEND_RECEIPT_TYPES, toWire, type SpendReceiptMessage } from "../packages/router/src/receipt.js";

const agent = privateKeyToAccount(generatePrivateKey());
const key = postQuantumKey(newPostQuantumSeed());
const domain = spendReceiptDomain(5042);
const limits = { perPaymentCap: 10_000n, dailyCap: 1_000_000n, perSellerCap: 500_000n };
const message: SpendReceiptMessage = {
  agent: agent.address,
  resource: "https://api.cra-agent.tech/v1/paid/fees/forecast",
  payTo: "0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74",
  network: "eip155:5042",
  amount: 1_000n,
  status: "sample",
  settlementId: "",
  policyHash: policyHash({ sample: true, perPaymentCapUsdc: "0.01", dailyCapUsdc: "1", perSellerCapUsdc: "0.5" }),
  ...limits,
  spentTodayBefore: 42_000n,
  spentWithSellerBefore: 3_000n,
  issuedAt: BigInt(Math.floor(Date.now() / 1000)),
};
const signature = await agent.signTypedData({ domain, types: SPEND_RECEIPT_TYPES, primaryType: "SpendReceipt", message });
const signed = coSignSpendReceipt({ domain, message: toWire(message), signature }, { key, keyStatement: await signKeyStatement(agent, domain, key.publicKey) });
console.log(JSON.stringify(signed, null, 1));
