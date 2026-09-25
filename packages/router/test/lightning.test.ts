import { describe, expect, it } from "vitest";
import { MemoryLedger } from "@cra-agent/ledger";
import { createSigner } from "@cra-agent/identity";
import { parsePolicyString } from "@cra-agent/policy";
import { httpBinding, issueLnbtcChallenge, LNBTC_MAINNET, localLightning, MemoryReplayStore, settleLnbtc } from "@cra-agent/lightning";
import { createRail, LightningNotPaid, PolicyRejected } from "../src/index.js";

const URL_ = "https://seller.example/v1/lightning/data?x=1";
const NODE_KEY = new Uint8Array(32).map((_, i) => (i === 31 ? 9 : 0));
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

/** A seller that takes bitcoin the way the scheme says; `lie` binds its invoice to another request. */
function lightningSeller(o: { priceMsat?: string; lie?: boolean } = {}) {
  const priceMsat = o.priceMsat ?? "1200";
  const node = localLightning({ privateKey: NODE_KEY });
  const replay = new MemoryReplayStore();
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const bound = (url: string) => httpBinding({ method: req.method, url, body: null, header: (n) => req.headers.get(n) }, { headers: [] }).requestHash;
    const proof = req.headers.get("payment-signature");
    if (!proof) {
      calls.push("challenge");
      const r = await issueLnbtcChallenge({ receiver: node.receiver, network: LNBTC_MAINNET, amountMsat: priceMsat, maxTimeoutSeconds: 300, profile: "http:1", params: { headers: [] }, requestHash: bound(o.lie ? "https://seller.example/v1/lightning/other" : req.url) });
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64({ x402Version: 2, error: "Payment required", resource: { url: req.url }, accepts: [r] }) } });
    }
    calls.push("paid");
    const payload = JSON.parse(Buffer.from(proof, "base64").toString("utf8"));
    const requirements = { scheme: "exact", network: LNBTC_MAINNET, amount: priceMsat, asset: "BTC", payTo: node.receiver.pubkey, maxTimeoutSeconds: 300, extra: { assetTransferMethod: "bolt11", paymentFlow: "upfront", requestHash: bound(req.url), requestBindingProfile: "http:1", requestBindingParams: { headers: [] }, invoice: payload.accepted.extra.invoice } };
    const s = await settleLnbtc(payload, requirements, { replay });
    if (!s.success) return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64({ x402Version: 2, error: s.errorReason, accepts: [] }) } });
    return new Response(JSON.stringify({ data: 42 }), { status: 200, headers: { "PAYMENT-RESPONSE": b64(s), "content-type": "application/json" } });
  }) as typeof fetch;
  return { node, fetchImpl, calls, replay };
}

function rail(seller: ReturnType<typeof lightningSeller>, policy = "daily=1,per_seller=1,per_payment=0.05,networks=eip155:5042|lnbtc:000000000019d6689c085ae165831e93") {
  const ledger = new MemoryLedger();
  const signer = createSigner({ scheme: "secp256k1", privateKey: `0x${"42".repeat(32)}` });
  const r = createRail({ network: "arc", signer, policy: parsePolicyString(policy), ledger, identity: null, agentId: "test", fetch: seller.fetchImpl, lightning: { payer: seller.node.payer, rate: async () => ({ rate: "84000" }) } });
  return { rail: r, ledger };
}

describe("paying a seller in bitcoin over Lightning", () => {
  it("checks the invoice, pays it, sends the proof, and keeps a receipt priced in dollars", async () => {
    const s = lightningSeller();
    const { rail: r, ledger } = rail(s);
    const { response, receipt } = await r.fetchLightning(URL_);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: 42 });
    // 1,200 msat at $84,000 a bitcoin: $0.001008, rounded up to the micro-dollar.
    expect(receipt).toMatchObject({ status: "settled", amountUsdc: "0.001008", network: LNBTC_MAINNET, payTo: s.node.receiver.pubkey, resource: URL_, reason: null });
    expect(receipt!.txHash).toMatch(/^[0-9a-f]{64}$/);
    const [row] = await ledger.recent("test", 1);
    expect(row).toMatchObject({ rail: "lightning", status: "settled", asset: "BTC", txHash: receipt!.txHash });
    expect(row!.meta).toMatchObject({ amountMsat: "1200", btcUsd: "84000" });
    expect(s.calls).toEqual(["challenge", "paid"]);
  });

  it("refuses before paying when the price in dollars breaks the policy or the call's ceiling", async () => {
    for (const [policy, max, rule] of [
      ["daily=1,per_seller=1,per_payment=0.001,networks=lnbtc:000000000019d6689c085ae165831e93", undefined, "per_payment"],
      [undefined, "0.001", "max_price"],
      ["daily=1,per_seller=1,per_payment=0.05", undefined, "network"],
    ] as const) {
      const s = lightningSeller();
      const { rail: r, ledger } = rail(s, policy);
      const err = await r.fetchLightning(URL_, undefined, max ? { maxUsdc: max } : {}).catch((e) => e);
      expect(err).toBeInstanceOf(PolicyRejected);
      expect((err as PolicyRejected).decision.rule).toBe(rule);
      expect(s.calls).toEqual(["challenge"]);
      expect((await ledger.recent("test", 1))[0]).toMatchObject({ status: "rejected", rail: "lightning" });
    }
  });

  it("pays nothing for an invoice bound to another request", async () => {
    const s = lightningSeller({ lie: true });
    const err = await rail(s).rail.fetchLightning(URL_).catch((e) => e);
    expect(err).toBeInstanceOf(LightningNotPaid);
    expect((err as LightningNotPaid).reason).toBe("invalid_exact_lnbtc_request_mismatch");
    expect(s.calls).toEqual(["challenge"]);
  });

  it("says so when a seller refuses the proof after the sats have gone", async () => {
    const s = lightningSeller();
    // Every claim fails, as if the proof had been used already.
    s.replay.claim = async () => false;
    const { receipt } = await rail(s).rail.fetchLightning(URL_);
    expect(receipt).toMatchObject({ status: "failed", reason: "paid 1200 msat, but the seller refused the proof: duplicate_settlement" });
  });
});
