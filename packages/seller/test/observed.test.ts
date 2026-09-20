import { x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { describe, expect, it } from "vitest";
import { observed, type SettlementEvent } from "../src/index.js";

const NET = "eip155:5042";
const PAYER = "0x4F8C000000000000000000000000000000049A3a";
const SELLER = "0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74";
const requirements = { scheme: "exact", network: NET, asset: "0x3600000000000000000000000000000000000000", amount: "3000", payTo: SELLER, maxTimeoutSeconds: 120, extra: { name: "USDC", version: "2" } } as any;
const payload = { x402Version: 2, resource: { url: "https://api.cra-agent.tech/v1/direct/fx/execution?symbol=EURC" }, accepted: requirements, payload: { authorization: { from: PAYER }, signature: "0x" } } as any;

/** A facilitator that answers whatever the test tells it to. */
async function serverAnswering(settle: () => Promise<unknown>, seen: SettlementEvent[]) {
  const client = {
    verify: async () => ({ isValid: true, payer: PAYER }),
    settle,
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: NET }], extensions: [], signers: {} }),
  } as any;
  const server = observed({ onSettlement: (e) => void seen.push(e) }, new x402ResourceServer(client).register(NET, new ExactEvmScheme()));
  await server.initialize();
  return server;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("what the seller is told about a verified payment", () => {
  it("reports a settlement with its transaction and the payer the facilitator named", async () => {
    const seen: SettlementEvent[] = [];
    const server = await serverAnswering(async () => ({ success: true, transaction: "0xabc", network: NET, payer: PAYER }), seen);
    await server.settlePayment(payload, requirements);
    await flush();
    expect(seen).toEqual([{ outcome: "settled", network: NET, payer: PAYER, payTo: SELLER, amount: "3000", transaction: "0xabc", reason: null, resource: payload.resource.url }]);
  });

  it("reports a refused settlement as failed, with the payer taken from what was signed", async () => {
    const seen: SettlementEvent[] = [];
    const server = await serverAnswering(async () => ({ success: false, errorReason: "insufficient_funds", transaction: "", network: NET }), seen);
    await server.settlePayment(payload, requirements).catch(() => {});
    await flush();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ outcome: "failed", payer: PAYER, transaction: null });
    expect(seen[0]!.reason).toContain("insufficient_funds");
  });

  it("does not let a sink that throws reach the payment", async () => {
    const client = { verify: async () => ({ isValid: true }), settle: async () => ({ success: true, transaction: "0xabc", network: NET }), getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: NET }], extensions: [], signers: {} }) } as any;
    const server = observed({ onSettlement: () => { throw new Error("database is down"); } }, new x402ResourceServer(client).register(NET, new ExactEvmScheme()));
    await server.initialize();
    await expect(server.settlePayment(payload, requirements)).resolves.toMatchObject({ success: true });
  });
});
