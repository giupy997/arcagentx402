import { describe, expect, it } from "vitest";
import { MemoryLedger } from "@cra-agent/ledger";
import { createSigner } from "@cra-agent/identity";
import { parsePolicyString } from "@cra-agent/policy";
import { createRail, PolicyRejected } from "../src/index.js";

const SELLER = "0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74";
const URL_ = "https://seller.example/v1/data";

/** A seller that lists one price and asks another at pay time: the 402 is all the rail ever sees. */
function seller(askedBaseUnits: string) {
  const calls: Array<{ paid: boolean }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // The x402 client hands the retry over as a Request carrying the payment header.
    const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
    const paid = headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT");
    calls.push({ paid });
    if (paid) return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    const required = {
      x402Version: 2,
      resource: { url: URL_, description: "data", mimeType: "application/json" },
      accepts: [{ scheme: "exact", network: "eip155:5042", amount: askedBaseUnits, asset: "0x3600000000000000000000000000000000000000", payTo: SELLER, maxTimeoutSeconds: 120, extra: { name: "USDC", version: "2" } }],
    };
    return new Response(JSON.stringify({}), { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(required)).toString("base64"), "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function rail(fetchImpl: typeof fetch, ledger = new MemoryLedger()) {
  const signer = createSigner({ scheme: "secp256k1", privateKey: `0x${"42".repeat(32)}` });
  return { ledger, rail: createRail({ network: "arc", signer, policy: parsePolicyString("daily=1,per_seller=1,per_payment=0.05"), ledger, identity: null, agentId: "test", fetch: fetchImpl }) };
}

describe("a ceiling for one call, on what the seller asks at pay time", () => {
  it("refuses a price raised after listing, even inside the limits, before anything is signed", async () => {
    const s = seller("3000"); // listed at 0.001, asks 0.003 now; the per-payment cap is 0.05
    const { rail: r, ledger } = rail(s.fetchImpl);
    const err = await r.fetch(URL_, undefined, { maxUsdc: "0.001" }).catch((e) => e);
    expect(err).toBeInstanceOf(PolicyRejected);
    expect((err as PolicyRejected).decision).toMatchObject({ allow: false, rule: "max_price" });
    expect(s.calls).toEqual([{ paid: false }]);
    const rows = await ledger.recent("test", 10);
    expect(rows[0]).toMatchObject({ status: "rejected" });
    expect(rows[0]!.reason).toMatch(/^max_price: the seller asks 0\.003 USDC, above the 0\.001 USDC ceiling/);
  });

  it("pays when the price asked is at or under the ceiling", async () => {
    const s = seller("1000");
    const { rail: r } = rail(s.fetchImpl);
    const res = await r.fetch(URL_, undefined, { maxUsdc: "0.001" });
    expect(res.response.status).toBe(200);
    expect(s.calls).toEqual([{ paid: false }, { paid: true }]);
  });

  it("without a ceiling, the policy alone decides, on the price asked at pay time", async () => {
    const s = seller("60000"); // 0.06, above the 0.05 per-payment cap
    const err = await rail(s.fetchImpl).rail.fetch(URL_).catch((e) => e);
    expect((err as PolicyRejected).decision).toMatchObject({ rule: "per_payment" });
    expect(s.calls).toEqual([{ paid: false }]);
  });
});
