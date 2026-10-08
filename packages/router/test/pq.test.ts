import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { decodeFunctionData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MemoryLedger } from "@cra-agent/ledger";
import { createSigner } from "@cra-agent/identity";
import { parsePolicyString } from "@cra-agent/policy";
import { coSignSpendReceipt, createRail, policyHash, receiptDigest, spendReceiptDomain, SPEND_RECEIPT_TYPES, toWire, verifySpendReceipt, type SignedSpendReceipt, type SpendReceiptMessage } from "../src/index.js";
import { ARC_PQ_VERIFY, ARC_PQ_VERIFY_ABI, arcVerifyCall, newPostQuantumSeed, parsePostQuantumSeed, postQuantumKey, PQ_SEED_BYTES, signKeyStatement, verifiedByArc } from "../src/pq.js";

const agent = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const domain = spendReceiptDomain(5042);
// A fixed seed, so the key is the same on every run: 48 bytes, as a key file holds them.
const key = postQuantumKey(Uint8Array.from({ length: PQ_SEED_BYTES }, (_, i) => i + 1));
const otherKey = postQuantumKey(Uint8Array.from({ length: PQ_SEED_BYTES }, (_, i) => 200 - i));

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

async function classic(message: SpendReceiptMessage): Promise<SignedSpendReceipt> {
  const signature = await agent.signTypedData({ domain, types: SPEND_RECEIPT_TYPES, primaryType: "SpendReceipt", message });
  return { domain, message: toWire(message), signature };
}

// SLH-DSA takes most of a second to sign, so the receipt every test starts from is made once.
let keyStatement: `0x${string}`;
let signed: SignedSpendReceipt;
beforeAll(async () => {
  keyStatement = await signKeyStatement(agent, domain, key.publicKey);
  signed = coSignSpendReceipt(await classic(base), { key, keyStatement });
});

describe("a receipt signed a second time, with a post-quantum signature", () => {
  it("is valid when both signatures hold, and says which key made the second", async () => {
    expect(signed.postQuantum).toMatchObject({ scheme: "slh-dsa-sha2-128s", publicKey: key.publicKey });
    expect((signed.postQuantum!.publicKey.length - 2) / 2).toBe(32);
    expect((signed.postQuantum!.signature.length - 2) / 2).toBe(7856);
    const check = await verifySpendReceipt(signed, agent.address, { requirePostQuantum: true });
    expect(check).toEqual({ valid: true, signer: agent.address, withinStatedLimits: true, reason: null, postQuantum: { scheme: "slh-dsa-sha2-128s", publicKey: key.publicKey } });
  });

  it("survives a trip through JSON", async () => {
    const wire = JSON.parse(JSON.stringify(signed)) as SignedSpendReceipt;
    expect((await verifySpendReceipt(wire)).postQuantum?.publicKey).toBe(key.publicKey);
  });

  it("is not valid with a broken second signature, even though the wallet's still holds", async () => {
    const sig = signed.postQuantum!.signature;
    const flipped = `${sig.slice(0, 300)}${sig[300] === "0" ? "1" : "0"}${sig.slice(301)}` as `0x${string}`;
    const check = await verifySpendReceipt({ ...signed, postQuantum: { ...signed.postQuantum!, signature: flipped } });
    expect(check).toMatchObject({ valid: false, reason: "the post-quantum signature does not match the receipt" });
    expect(check.postQuantum).toBeUndefined();
  });

  it("refuses a second signature lifted from another receipt", async () => {
    const other = await classic({ ...base, amount: 5n });
    const check = await verifySpendReceipt({ ...other, postQuantum: signed.postQuantum! });
    expect(check).toMatchObject({ valid: false, reason: "the post-quantum signature does not match the receipt" });
  });

  it("refuses a post-quantum key the agent's wallet never vouched for", async () => {
    const forged = await signKeyStatement(stranger, domain, key.publicKey);
    const check = await verifySpendReceipt({ ...signed, postQuantum: { ...signed.postQuantum!, keyStatement: forged } });
    expect(check).toMatchObject({ valid: false, reason: "the post-quantum key is not vouched for by the agent's wallet key" });
  });

  it("refuses a signature made by a different post-quantum key than the one it names", async () => {
    const check = await verifySpendReceipt({ ...signed, postQuantum: { ...signed.postQuantum!, signature: otherKey.sign(receiptDigest(signed)) } });
    expect(check).toMatchObject({ valid: false, reason: "the post-quantum signature does not match the receipt" });
  });

  it("refuses a scheme or a length it does not know, without trying to verify it", async () => {
    const wrongScheme = await verifySpendReceipt({ ...signed, postQuantum: { ...signed.postQuantum!, scheme: "ml-dsa-65" as never } });
    expect(wrongScheme).toMatchObject({ valid: false, reason: "post-quantum scheme ml-dsa-65 is not one this version checks" });
    const short = await verifySpendReceipt({ ...signed, postQuantum: { ...signed.postQuantum!, signature: "0x1234" } });
    expect(short).toMatchObject({ valid: false, reason: "the post-quantum signature is not 7856 bytes" });
  });

  it("leaves a receipt without one as valid as before, unless the checker asks for one", async () => {
    const plain = await classic(base);
    expect(await verifySpendReceipt(plain, agent.address)).toEqual({ valid: true, signer: agent.address, withinStatedLimits: true, reason: null });
    expect(await verifySpendReceipt(plain, agent.address, { requirePostQuantum: true })).toMatchObject({ valid: false, reason: "no post-quantum signature on this receipt" });
  });
});

describe("asking Arc to verify it", () => {
  it("builds the call the precompile takes: the key, the receipt's digest, the signature", () => {
    const call = arcVerifyCall(signed.postQuantum!, receiptDigest(signed));
    expect(call.to).toBe(ARC_PQ_VERIFY);
    const { functionName, args } = decodeFunctionData({ abi: ARC_PQ_VERIFY_ABI, data: call.data });
    expect(functionName).toBe("verifySlhDsaSha2128s");
    expect(args).toEqual([key.publicKey, receiptDigest(signed), signed.postQuantum!.signature]);
  });

  it("reads Arc's answer, and says so when Arc gives none", async () => {
    const asked: unknown[] = [];
    const arc = (answer: unknown) => (async (_url: RequestInfo | URL, init?: RequestInit) => (asked.push(JSON.parse(String(init!.body))), Response.json({ jsonrpc: "2.0", id: 1, ...(answer as object) }))) as typeof fetch;
    const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
    expect(await verifiedByArc(signed.postQuantum!, receiptDigest(signed), "http://arc.test", arc({ result: word(1) }))).toBe(true);
    expect(await verifiedByArc(signed.postQuantum!, receiptDigest(signed), "http://arc.test", arc({ result: word(0) }))).toBe(false);
    expect(asked[0]).toMatchObject({ method: "eth_call", params: [{ to: ARC_PQ_VERIFY }, "latest"] });
    await expect(verifiedByArc(signed.postQuantum!, receiptDigest(signed), "http://arc.test", arc({ error: { message: "Invalid verifying key length" } }))).rejects.toThrow(/Invalid verifying key length/);
  });
});

describe("the post-quantum key", () => {
  it("comes from 48 bytes, the same key from the same bytes", () => {
    expect(newPostQuantumSeed()).toHaveLength(48);
    expect(postQuantumKey(Uint8Array.from({ length: 48 }, (_, i) => i + 1)).publicKey).toBe(key.publicKey);
    expect(otherKey.publicKey).not.toBe(key.publicKey);
    expect(() => postQuantumKey(new Uint8Array(32))).toThrow(/48 bytes, got 32/);
  });

  it("is read from a key file as hex, and a wrong file is refused without repeating what is in it", () => {
    const hex = Array.from({ length: 48 }, (_, i) => (i + 1).toString(16).padStart(2, "0")).join("");
    expect(postQuantumKey(parsePostQuantumSeed(`0x${hex}\n`)).publicKey).toBe(key.publicKey);
    expect(postQuantumKey(parsePostQuantumSeed(hex)).publicKey).toBe(key.publicKey);
    const secret = "ab".repeat(32);
    for (const bad of [secret, `${hex}00`, "not hex at all"]) {
      const err = (() => {
        try {
          parsePostQuantumSeed(bad);
          return null;
        } catch (e) {
          return (e as Error).message;
        }
      })();
      expect(err, bad).toMatch(/48 bytes of hex/);
      expect(err).not.toContain(secret);
    }
  });
});

describe("an agent that has a post-quantum key", () => {
  const SELLER = "0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74";
  const URL_ = "https://seller.example/v1/upto/think?task=hello";
  const RPC = "http://rpc.test";
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

  // The chain, as far as the buyer asks it: Permit2 may not move this wallet's USDC yet, and its permit nonce is 0.
  beforeAll(() => {
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).startsWith(RPC)) return real(input, init);
      const { id } = JSON.parse(String(init!.body)) as { id: number };
      return Response.json({ jsonrpc: "2.0", id, result: `0x${"0".repeat(64)}` });
    });
  });
  afterAll(() => void vi.unstubAllGlobals());

  /** A seller billing by use, as in upto.test.ts: it takes 21,300 of a 100,000 ceiling. */
  const seller = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
    const signature = headers.get("PAYMENT-SIGNATURE");
    if (signature) {
      const p = JSON.parse(Buffer.from(signature, "base64").toString("utf8"));
      return new Response(JSON.stringify({ answer: 42 }), { status: 200, headers: { "content-type": "application/json", "PAYMENT-RESPONSE": b64({ success: true, transaction: `0x${"cd".repeat(32)}`, network: "eip155:5042", payer: p.payload.permit2Authorization.from, amount: "21300" }) } });
    }
    const required = {
      x402Version: 2,
      resource: { url: URL_, description: "an agent's work, billed by what it spent", mimeType: "application/json" },
      accepts: [{ scheme: "upto", network: "eip155:5042", amount: "100000", asset: "0x3600000000000000000000000000000000000000", payTo: SELLER, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2", assetTransferMethod: "permit2", facilitatorAddress: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf" } }],
      extensions: { eip2612GasSponsoring: { info: { description: "gasless Permit2 approval", version: "1" }, schema: {} } },
    };
    return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64(required), "content-type": "application/json" } });
  }) as typeof fetch;

  const rail = (postQuantum?: typeof key) =>
    createRail({ network: "arc", signer: createSigner({ scheme: "secp256k1", privateKey: `0x${"42".repeat(32)}` }), policy: parsePolicyString("daily=1,per_seller=1,per_payment=0.15"), ledger: new MemoryLedger(), identity: null, agentId: "test", fetch: seller, rpcUrl: RPC, ...(postQuantum ? { postQuantum } : {}) });

  it("signs every receipt twice, and the payment is the same payment", async () => {
    const res = await rail(key).fetch(URL_);
    expect(res.receipt).toMatchObject({ status: "settled", amountUsdc: "0.0213" });
    const receipt = res.receipt!.attestation!;
    expect(receipt.postQuantum).toMatchObject({ scheme: "slh-dsa-sha2-128s", publicKey: key.publicKey });
    expect(await verifySpendReceipt(receipt, undefined, { requirePostQuantum: true })).toMatchObject({ valid: true, withinStatedLimits: true, postQuantum: { publicKey: key.publicKey } });
  });

  it("signs once, as before, when it has none", async () => {
    const res = await rail().fetch(URL_);
    expect(res.receipt!.attestation!.postQuantum).toBeUndefined();
    expect((await verifySpendReceipt(res.receipt!.attestation!)).valid).toBe(true);
  });
});
