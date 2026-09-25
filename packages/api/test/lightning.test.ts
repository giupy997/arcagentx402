import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { checkLnbtcChallenge, LNBTC_MAINNET, localLightning, MemoryReplayStore, payLnbtcChallenge, type BtcUsd } from "@cra-agent/lightning";
import { lightningMiddleware, type LightningSettled } from "../src/lightning.js";

const T = 1_790_000_000;
const KEY = new Uint8Array(32).fill(0).map((_, i) => (i === 31 ? 7 : 0));
const ORIGIN = "https://api.cra-agent.tech";
const decode = (h: string | null) => JSON.parse(Buffer.from(h!, "base64").toString("utf8"));
const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

function world(o: { rate?: () => Promise<BtcUsd>; perClient?: number } = {}) {
  let usd = "84000";
  const node = localLightning({ privateKey: KEY, now: () => T });
  const settled: LightningSettled[] = [];
  const app = new Hono();
  app.use(
    "/v1/lightning/*",
    lightningMiddleware({
      receiver: async () => node.receiver,
      network: LNBTC_MAINNET,
      publicOrigin: ORIGIN,
      routes: [
        { path: "/v1/lightning/fees/estimate", priceUsd: "0.001", description: "fee estimate" },
        { path: "/v1/lightning/rpc/health", priceUsd: "0.001", description: "rpc health" },
      ],
      replay: new MemoryReplayStore(),
      rate: o.rate ?? (async () => ({ rate: usd, sources: {}, at: 0 })),
      limits: { perClient: o.perClient ?? 30, total: 600 },
      onSettled: (e) => void settled.push(e),
      now: () => T * 1000,
    }),
  );
  app.get("/v1/lightning/fees/estimate", (c) => c.json({ gwei: 20 }));
  app.get("/v1/lightning/rpc/health", (c) => c.json({ ok: true }));
  return { app, node, settled, setUsd: (v: string) => (usd = v) };
}

async function buy(w: ReturnType<typeof world>, path: string) {
  const res = await w.app.request(`http://api.cra-agent.tech${path}`);
  expect(res.status).toBe(402);
  const required = decode(res.headers.get("PAYMENT-REQUIRED"));
  const checked = checkLnbtcChallenge(required.accepts[0], { profile: "http:1", request: { method: "GET", url: `${ORIGIN}${path}`, body: null, header: () => null }, resourceUrl: required.resource.url }, { now: T });
  if (!checked.ok) throw new Error(checked.reason);
  const paid = await payLnbtcChallenge(checked, w.node.payer);
  if (!paid.ok) throw new Error(paid.reason);
  return { required, checked, payload: paid.payload };
}

describe("our routes paid over Lightning", () => {
  it("answers 402 with a fresh invoice bound to the request, then serves the paid retry with a receipt", async () => {
    const w = world();
    const { required, checked, payload } = await buy(w, "/v1/lightning/fees/estimate?gas=21000");
    expect(required.resource.url).toBe(`${ORIGIN}/v1/lightning/fees/estimate?gas=21000`);
    // $0.001 at $84,000 a bitcoin, rounded up: 1,191 millisatoshis.
    expect(required.accepts[0]).toMatchObject({ scheme: "exact", network: LNBTC_MAINNET, amount: "1191", asset: "BTC", payTo: w.node.receiver.pubkey, maxTimeoutSeconds: 300 });
    const res = await w.app.request("http://api.cra-agent.tech/v1/lightning/fees/estimate?gas=21000", { headers: { "PAYMENT-SIGNATURE": encode(payload) } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ gwei: 20 });
    expect(decode(res.headers.get("PAYMENT-RESPONSE"))).toEqual({ success: true, transaction: checked.invoice.paymentHash, network: LNBTC_MAINNET });
    expect(w.settled).toEqual([{ route: "/v1/lightning/fees/estimate", paymentHash: checked.invoice.paymentHash, amountMsat: "1191", priceUsd: "0.001", status: 200 }]);
  });

  it("serves a proof once, and only for the request its invoice was issued for", async () => {
    const w = world();
    const { payload } = await buy(w, "/v1/lightning/fees/estimate?gas=21000");
    const again = () => w.app.request("http://api.cra-agent.tech/v1/lightning/fees/estimate?gas=21000", { headers: { "PAYMENT-SIGNATURE": encode(payload) } });
    expect((await again()).status).toBe(200);
    const dup = await again();
    expect(dup.status).toBe(402);
    expect(decode(dup.headers.get("PAYMENT-REQUIRED")).error).toBe("duplicate_settlement");
    const { payload: other } = await buy(w, "/v1/lightning/fees/estimate?gas=21000");
    const elsewhere = await w.app.request("http://api.cra-agent.tech/v1/lightning/rpc/health", { headers: { "PAYMENT-SIGNATURE": encode(other) } });
    expect(elsewhere.status).toBe(402);
    expect((await elsewhere.json()).error).toBe("invalid_exact_lnbtc_request_mismatch");
    const otherQuery = await w.app.request("http://api.cra-agent.tech/v1/lightning/fees/estimate?gas=50000", { headers: { "PAYMENT-SIGNATURE": encode(other) } });
    expect((await otherQuery.json()).error).toBe("invalid_exact_lnbtc_request_mismatch");
  });

  it("keeps the invoice's amount through a small move in the rate, not a large one", async () => {
    const w = world();
    const small = await buy(w, "/v1/lightning/fees/estimate");
    w.setUsd("86000"); // 2.4% dearer bitcoin: 1,163 msat today against 1,191 invoiced
    expect((await w.app.request("http://api.cra-agent.tech/v1/lightning/fees/estimate", { headers: { "PAYMENT-SIGNATURE": encode(small.payload) } })).status).toBe(200);
    w.setUsd("84000");
    const large = await buy(w, "/v1/lightning/fees/estimate");
    w.setUsd("95000");
    const res = await w.app.request("http://api.cra-agent.tech/v1/lightning/fees/estimate", { headers: { "PAYMENT-SIGNATURE": encode(large.payload) } });
    expect((await res.json()).error).toBe("invalid_exact_lnbtc_amount_mismatch");
  });

  it("without a rate: no new invoice, but a paid proof still settles", async () => {
    let up = true;
    const w = world({ rate: async () => { if (!up) throw new Error("down"); return { rate: "84000", sources: {}, at: 0 }; } });
    const { payload } = await buy(w, "/v1/lightning/fees/estimate");
    up = false;
    expect((await w.app.request("http://api.cra-agent.tech/v1/lightning/fees/estimate")).status).toBe(503);
    expect((await w.app.request("http://api.cra-agent.tech/v1/lightning/fees/estimate", { headers: { "PAYMENT-SIGNATURE": encode(payload) } })).status).toBe(200);
  });

  it("limits how many invoices one address can make a minute", async () => {
    const w = world({ perClient: 2 });
    const ask = () => w.app.request("http://api.cra-agent.tech/v1/lightning/rpc/health", { headers: { "x-forwarded-for": "198.51.100.7" } });
    expect((await ask()).status).toBe(402);
    expect((await ask()).status).toBe(402);
    const third = await ask();
    expect(third.status).toBe(429);
    expect((await third.json()).error).toBe("exact_lnbtc_invoice_issuance_denied");
  });
});
