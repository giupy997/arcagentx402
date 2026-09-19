import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { policyHash, spendReceiptDomain, SPEND_RECEIPT_TYPES, toWire, verifySpendReceipt, type SignedSpendReceipt, type SpendReceiptMessage } from "../src/attest.js";

const agent = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const domain = spendReceiptDomain(5042);

const base: SpendReceiptMessage = {
  agent: agent.address,
  resource: "https://api.cra-agent.tech/v1/paid/rpc/health",
  payTo: "0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74",
  network: "eip155:5042",
  amount: 500n,
  status: "settled",
  settlementId: "3faa5635-789f-45c0-b44a-aef1df26c6b8",
  policyHash: policyHash({ dailyCapUsdc: "5", perPaymentCapUsdc: "0.05" }),
  perPaymentCap: 50_000n,
  dailyCap: 5_000_000n,
  perSellerCap: 500_000n,
  spentTodayBefore: 310_000n,
  spentWithSellerBefore: 1_000n,
  issuedAt: 1_790_000_000n,
};

async function sign(message: SpendReceiptMessage, by = agent): Promise<SignedSpendReceipt> {
  const signature = await by.signTypedData({ domain, types: SPEND_RECEIPT_TYPES, primaryType: "SpendReceipt", message });
  return { domain, message: toWire(message), signature };
}

describe("a spend receipt someone else can check", () => {
  it("verifies, names its signer, and confirms the payment fitted its limits", async () => {
    const check = await verifySpendReceipt(await sign(base), agent.address);
    expect(check).toEqual({ valid: true, signer: agent.address, withinStatedLimits: true, reason: null });
  });

  it("survives a trip through JSON, which is how it will travel", async () => {
    const wire = JSON.parse(JSON.stringify(await sign(base))) as SignedSpendReceipt;
    expect((await verifySpendReceipt(wire)).valid).toBe(true);
  });

  it("breaks when a single figure is changed after signing", async () => {
    const signed = await sign(base);
    const cheaper = { ...signed, message: { ...signed.message, amount: "5" } };
    const check = await verifySpendReceipt(cheaper);
    expect(check.valid).toBe(false);
    expect(check.reason).toMatch(/different key/);
  });

  it("refuses a receipt signed by someone other than the agent it names", async () => {
    const check = await verifySpendReceipt(await sign(base, stranger));
    expect(check.valid).toBe(false);
  });

  it("refuses a genuine receipt from the wrong agent", async () => {
    const check = await verifySpendReceipt(await sign({ ...base, agent: stranger.address }, stranger), agent.address);
    expect(check.valid).toBe(false);
    expect(check.reason).toMatch(/different agent/);
  });

  it("says so when a properly signed receipt states limits it does not fit", async () => {
    // The signature is fine; the arithmetic is not. A verifier should see both facts separately.
    for (const over of [{ amount: 60_000n }, { spentTodayBefore: 4_999_900n }, { spentWithSellerBefore: 499_900n }]) {
      const check = await verifySpendReceipt(await sign({ ...base, ...over }));
      expect(check.valid).toBe(true);
      expect(check.withinStatedLimits).toBe(false);
    }
  });

  it("does not throw on garbage", async () => {
    const check = await verifySpendReceipt({ domain, message: { ...toWire(base), amount: "not a number" }, signature: "0x00" } as SignedSpendReceipt);
    expect(check.valid).toBe(false);
    expect(check.reason).toMatch(/unreadable/);
  });
});

describe("the policy fingerprint", () => {
  it("does not depend on key order, and changes when a limit changes", () => {
    expect(policyHash({ a: 1, b: { y: 2, x: [1, 2] } })).toBe(policyHash({ b: { x: [1, 2], y: 2 }, a: 1 }));
    expect(policyHash({ dailyCapUsdc: "5" })).not.toBe(policyHash({ dailyCapUsdc: "6" }));
  });
});
