import { beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ARC_PQ_VERIFY, coSignSpendReceipt, findSignedReceipt, inspectReceipt, policyHash, postQuantumKey, PQ_SEED_BYTES, signKeyStatement, spendReceiptDomain, SPEND_RECEIPT_TYPES, toWire, type SignedSpendReceipt, type SpendReceiptMessage } from "../src/receipt.js";

const agent = privateKeyToAccount(generatePrivateKey());
const domain = spendReceiptDomain(5042);
const key = postQuantumKey(Uint8Array.from({ length: PQ_SEED_BYTES }, (_, i) => i + 7));
const base: SpendReceiptMessage = {
  agent: agent.address, resource: "https://api.cra-agent.tech/v1/paid/rpc/health", payTo: "0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74", network: "eip155:5042", amount: 500n, status: "settled",
  settlementId: "3faa5635-789f-45c0-b44a-aef1df26c6b8", policyHash: policyHash({ dailyCapUsdc: "5" }), perPaymentCap: 50_000n, dailyCap: 5_000_000n, perSellerCap: 500_000n,
  spentTodayBefore: 310_000n, spentWithSellerBefore: 1_000n, issuedAt: 1_790_000_000n,
};
const classic = async (message: SpendReceiptMessage): Promise<SignedSpendReceipt> => ({ domain, message: toWire(message), signature: await agent.signTypedData({ domain, types: SPEND_RECEIPT_TYPES, primaryType: "SpendReceipt", message }) });

let once: SignedSpendReceipt;
let twice: SignedSpendReceipt;
beforeAll(async () => {
  once = await classic(base);
  twice = coSignSpendReceipt(once, { key, keyStatement: await signKeyStatement(agent, domain, key.publicKey) });
});

/** Arc, as far as the check asks it: one endpoint that answers the precompile call, or fails. */
const arc = (answer: boolean | "down") => {
  const asked: string[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    asked.push(String(url));
    if (answer === "down" || String(url).includes("dead")) throw new TypeError("fetch failed");
    expect(JSON.parse(String(init!.body))).toMatchObject({ method: "eth_call", params: [{ to: ARC_PQ_VERIFY }, "latest"] });
    return Response.json({ jsonrpc: "2.0", id: 1, result: `0x${(answer ? 1 : 0).toString(16).padStart(64, "0")}` });
  }) as typeof fetch;
  return { fetchImpl, asked };
};

describe("finding the signed receipt in what was handed over", () => {
  it("takes the signed object, a receipt that carries it, or the whole output of pay", () => {
    expect(findSignedReceipt(once)).toBe(once);
    expect(findSignedReceipt({ attestation: once, status: "settled" })).toBe(once);
    expect(findSignedReceipt({ response: { status: 200 }, receipt: { attestation: twice } })).toBe(twice);
  });

  it("finds nothing in anything else", () => {
    for (const not of [null, 42, "receipt", [], {}, { receipt: { attestation: null } }, { domain: {}, message: {} }, { domain: {}, message: {}, signature: 7 }]) expect(findSignedReceipt(not), JSON.stringify(not)).toBeNull();
  });
});

describe("a receipt checked part by part", () => {
  it("reports each check of a receipt signed twice, and Arc's answer with the endpoint that gave it", async () => {
    const { fetchImpl, asked } = arc(true);
    const report = await inspectReceipt(twice, { expectedAgent: agent.address, arcRpcUrls: ["https://dead.example", "https://arc.example"], fetch: fetchImpl });
    expect(report).toEqual({
      wallet: { ok: true, detail: `signed by ${agent.address}, the agent it names` },
      limits: { ok: true, detail: "the payment fits the limits the receipt states" },
      postQuantum: { ok: true, detail: `slh-dsa-sha2-128s, public key ${key.publicKey}` },
      arc: { ok: true, answered: true, endpoint: "https://arc.example", detail: "Arc's precompile verified the signature" },
      valid: true,
    });
    expect(asked).toEqual(["https://dead.example", "https://arc.example"]);
  });

  it("is not valid when Arc says the signature is not, and still valid when Arc cannot be reached", async () => {
    const refused = await inspectReceipt(twice, { arcRpcUrls: ["https://arc.example"], fetch: arc(false).fetchImpl });
    expect(refused).toMatchObject({ postQuantum: { ok: true }, arc: { ok: false, answered: true }, valid: false });
    const unreachable = await inspectReceipt(twice, { arcRpcUrls: ["https://arc.example"], fetch: arc("down").fetchImpl });
    expect(unreachable).toMatchObject({ arc: { ok: false, answered: false, endpoint: null }, valid: true });
    expect(unreachable.arc!.detail).toMatch(/^Arc could not be asked: /);
  });

  it("does not ask Arc unless told where, nor about a receipt signed once", async () => {
    expect((await inspectReceipt(twice)).arc).toBeNull();
    const { fetchImpl, asked } = arc(true);
    expect(await inspectReceipt(once, { arcRpcUrls: ["https://arc.example"], fetch: fetchImpl })).toMatchObject({ wallet: { ok: true }, limits: { ok: true }, postQuantum: null, arc: null, valid: true });
    expect(asked).toEqual([]);
  });

  it("shows which part fails: a changed figure breaks both signatures, a changed second signature only that one", async () => {
    const { fetchImpl, asked } = arc(true);
    const changed = await inspectReceipt({ ...twice, message: { ...twice.message, amount: "5" } }, { arcRpcUrls: ["https://arc.example"], fetch: fetchImpl });
    expect(changed).toMatchObject({ wallet: { ok: false }, limits: { ok: false, detail: "not checked: the figures cannot be trusted without the signature" }, postQuantum: { ok: false }, arc: null, valid: false });
    const sig = twice.postQuantum!.signature;
    const broken = await inspectReceipt({ ...twice, postQuantum: { ...twice.postQuantum!, signature: `${sig.slice(0, 500)}${sig[500] === "a" ? "b" : "a"}${sig.slice(501)}` as `0x${string}` } }, { arcRpcUrls: ["https://arc.example"], fetch: fetchImpl });
    expect(broken).toMatchObject({ wallet: { ok: true }, limits: { ok: true }, postQuantum: { ok: false, detail: "the post-quantum signature does not match the receipt" }, arc: null, valid: false });
    // A signature that does not hold here is not sent to Arc: there is nothing left to learn from it.
    expect(asked).toEqual([]);
  });

  it("says so when the payment does not fit the limits the receipt itself states", async () => {
    const over = await inspectReceipt(await classic({ ...base, amount: 60_000n }));
    expect(over).toMatchObject({ wallet: { ok: true }, limits: { ok: false, detail: "the amounts in the receipt do not fit the limits it states" }, valid: false });
  });
});
