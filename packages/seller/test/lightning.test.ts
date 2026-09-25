import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkLnbtcChallenge, LNBTC_MAINNET, lnbtcFacilitatorClient, localLightning, MemoryReplayStore, payLnbtcChallenge, settleLnbtc, type LnbtcFacilitatorClient } from "@cra-agent/lightning";
import { createProxyApp, type LightningSettlement } from "../src/proxy.js";

const PAY_TO = "0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74";
const FACILITATOR = "https://facilitator.test";
const KEY = new Uint8Array(32).map((_, i) => (i === 31 ? 11 : 0));
const decode = (h: string | null) => JSON.parse(Buffer.from(h!, "base64").toString("utf8"));
const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

// The Arc paywall asks its facilitator what it supports before its first 402; nothing else leaves the test.
beforeAll(() => {
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === `${FACILITATOR}/supported` ? Response.json({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:5042" }], extensions: [], signers: {} }) : real(input, init),
  );
});
afterAll(() => void vi.unstubAllGlobals());

function world(o: { slowNode?: boolean; facilitator?: LnbtcFacilitatorClient } = {}) {
  const node = localLightning({ privateKey: KEY });
  const upstream: Array<{ url: string; body: string }> = [];
  const settled: LightningSettlement[] = [];
  let invoices = 0;
  const receiver = {
    pubkey: node.receiver.pubkey,
    async createInvoice(a: Parameters<typeof node.receiver.createInvoice>[0]) {
      invoices++;
      if (o.slowNode) await new Promise((r) => setTimeout(r, 200));
      return node.receiver.createInvoice(a);
    },
  };
  const app = createProxyApp({
    target: "https://api.example.com",
    payTo: PAY_TO,
    network: "arc",
    routes: [{ pattern: "/*", price: "0.002" }],
    free: ["/health"],
    facilitatorUrl: FACILITATOR,
    lightning: { receiver, network: LNBTC_MAINNET, ...(o.facilitator ? { facilitator: o.facilitator } : { replay: new MemoryReplayStore() }), rate: async () => ({ rate: "84000", sources: {}, at: 0 }), offerTimeoutMs: 100, onSettled: (e) => void settled.push(e) },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      upstream.push({ url: String(input), body: init?.body ? Buffer.from(init.body as ArrayBuffer).toString() : "" });
      return Response.json({ answer: 42 });
    }) as typeof fetch,
  });
  return { app, node, upstream, settled, invoices: () => invoices };
}

/** A buyer that checks the 402's invoice against its own request, pays it, and keeps the proof. */
async function pay(w: ReturnType<typeof world>, url: string, init: { method?: string; body?: string } = {}) {
  const first = await w.app.request(url, { ...init, headers: { accept: "application/json" } });
  expect(first.status).toBe(402);
  const required = decode(first.headers.get("PAYMENT-REQUIRED"));
  const offer = required.accepts.find((a: { network: string }) => a.network.startsWith("lnbtc:"));
  const body = init.body === undefined ? null : new TextEncoder().encode(init.body);
  const checked = checkLnbtcChallenge(offer, { profile: "http:1", request: { method: init.method ?? "GET", url, body, header: () => null }, resourceUrl: required.resource.url });
  if (!checked.ok) throw new Error(checked.reason);
  const paid = await payLnbtcChallenge(checked, w.node.payer);
  if (!paid.ok) throw new Error(paid.reason);
  return { required, checked, proof: encode(paid.payload) };
}

describe("selling an API in sats as well", () => {
  it("puts an invoice for the dollar price next to the Arc offer, bound to the request", async () => {
    const w = world();
    const { required, checked } = await pay(w, "http://seller.test/v1/forecast?city=rome");
    expect(required.accepts.map((a: { network: string }) => a.network)).toEqual(["eip155:5042", LNBTC_MAINNET]);
    // $0.002 at $84,000 a bitcoin is 2,381 millisatoshis, rounded up to a whole sat: 3 sats.
    expect(required.accepts[1]).toMatchObject({ scheme: "exact", amount: "3000", asset: "BTC", payTo: w.node.receiver.pubkey, maxTimeoutSeconds: 300 });
    expect(checked.invoice.amountMsat).toBe("3000");
  });

  it("serves a paid retry after checking the proof, once, and says what was settled", async () => {
    const w = world();
    const url = "http://seller.test/v1/forecast?city=rome";
    const { checked, proof } = await pay(w, url);
    const res = await w.app.request(url, { headers: { "PAYMENT-SIGNATURE": proof } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ answer: 42 });
    expect(decode(res.headers.get("PAYMENT-RESPONSE"))).toEqual({ success: true, transaction: checked.invoice.paymentHash, network: LNBTC_MAINNET });
    expect(w.upstream.map((u) => u.url)).toEqual(["https://api.example.com/v1/forecast?city=rome"]);
    expect(w.settled).toEqual([{ resource: url, paymentHash: checked.invoice.paymentHash, amountMsat: "3000", priceUsd: "0.002", status: 200 }]);

    const again = await w.app.request(url, { headers: { "PAYMENT-SIGNATURE": proof } });
    expect(again.status).toBe(402);
    expect(decode(again.headers.get("PAYMENT-REQUIRED")).error).toBe("duplicate_settlement");
    expect(w.upstream).toHaveLength(1);
  });

  it("binds the body too: a proof bought for one body does not buy another", async () => {
    const w = world();
    const { proof } = await pay(w, "http://seller.test/v1/render", { method: "POST", body: '{"scene":1}' });
    const other = await w.app.request("http://seller.test/v1/render", { method: "POST", body: '{"scene":2}', headers: { "PAYMENT-SIGNATURE": proof } });
    expect(other.status).toBe(402);
    expect(decode(other.headers.get("PAYMENT-REQUIRED")).error).toBe("invalid_exact_lnbtc_request_mismatch");
    const same = await w.app.request("http://seller.test/v1/render", { method: "POST", body: '{"scene":1}', headers: { "PAYMENT-SIGNATURE": proof } });
    expect(same.status).toBe(200);
    expect(w.upstream.map((u) => u.body)).toEqual(['{"scene":1}']);
  });

  it("asks the node for nothing on a browser's paywall page or a free path, and waits for a slow node only so long", async () => {
    const w = world();
    const page = await w.app.request("http://seller.test/v1/forecast", { headers: { accept: "text/html", "user-agent": "Mozilla/5.0" } });
    expect(page.status).toBe(402);
    expect((await w.app.request("http://seller.test/health")).status).toBe(200);
    expect(w.invoices()).toBe(0);

    const slow = world({ slowNode: true });
    const res = await slow.app.request("http://seller.test/v1/forecast", { headers: { accept: "application/json" } });
    expect(res.status).toBe(402);
    expect(decode(res.headers.get("PAYMENT-REQUIRED")).accepts.map((a: { network: string }) => a.network)).toEqual(["eip155:5042"]);
  });

  it("can leave the proofs to a facilitator, which then remembers them in its place", async () => {
    const replay = new MemoryReplayStore();
    const calls: string[] = [];
    const facilitatorFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input).replace("https://facilitator.example", ""));
      if (String(input).endsWith("/supported")) return Response.json({ kinds: [{ x402Version: 2, scheme: "exact", network: LNBTC_MAINNET }] });
      const b = JSON.parse(String(init!.body));
      const s = await settleLnbtc(b.paymentPayload, b.paymentRequirements, { replay });
      return Response.json(s.success ? s : { ...s, transaction: "" });
    }) as typeof fetch;
    const facilitator = lnbtcFacilitatorClient("https://facilitator.example", { fetchImpl: facilitatorFetch });
    expect(await facilitator.supports(LNBTC_MAINNET)).toBe(true);
    const w = world({ facilitator });
    const url = "http://seller.test/v1/forecast";
    const { checked, proof } = await pay(w, url);
    const res = await w.app.request(url, { headers: { "PAYMENT-SIGNATURE": proof } });
    expect(res.status).toBe(200);
    expect(decode(res.headers.get("PAYMENT-RESPONSE")).transaction).toBe(checked.invoice.paymentHash);
    const again = await w.app.request(url, { headers: { "PAYMENT-SIGNATURE": proof } });
    expect(decode(again.headers.get("PAYMENT-REQUIRED")).error).toBe("duplicate_settlement");
    expect(calls).toEqual(["/supported", "/settle", "/settle"]);
    expect(w.upstream).toHaveLength(1);
    expect((await (await w.app.request("http://seller.test/.well-known/x402")).json()).lightning.settledBy).toBe("https://facilitator.example");
  });

  it("answers 503 when the facilitator cannot be reached, so the buyer can send the same proof again", async () => {
    const down = lnbtcFacilitatorClient("https://facilitator.example", { fetchImpl: (async () => new Response("busy", { status: 503 })) as typeof fetch });
    const w = world({ facilitator: down });
    const url = "http://seller.test/v1/forecast";
    const { proof } = await pay(w, url);
    const res = await w.app.request(url, { headers: { "PAYMENT-SIGNATURE": proof } });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/nothing was claimed/);
    expect(w.upstream).toHaveLength(0);
  });

  it("lists the Lightning rail with the node's key on /.well-known/x402", async () => {
    const w = world();
    const doc = await (await w.app.request("http://seller.test/.well-known/x402")).json();
    expect(doc.networks).toEqual(["eip155:5042", LNBTC_MAINNET]);
    expect(doc.lightning).toMatchObject({ network: LNBTC_MAINNET, payTo: w.node.receiver.pubkey, scheme: "exact", asset: "BTC" });
  });
});
