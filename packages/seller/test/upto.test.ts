import { x402Client } from "@x402/core/client";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { Hono } from "hono";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { charge, createSeller, type SettlementEvent } from "../src/index.js";

const NET = "eip155:5042";
const SELLER = "0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74";
const FACILITATOR = "https://facilitator.test";
const OUR_SIGNER = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const buyer = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000002");
const decode = (h: string | null) => JSON.parse(Buffer.from(h!, "base64").toString("utf8"));

// The facilitator is played here: it says what it settles, passes every payment, and settles what it is told.
const settled: Array<{ amount: string; extensions: Record<string, unknown> | undefined }> = [];
beforeAll(() => {
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith(FACILITATOR)) return real(input, init);
    if (url.endsWith("/supported")) return Response.json({ kinds: [{ x402Version: 2, scheme: "exact", network: NET }, { x402Version: 2, scheme: "upto", network: NET, extra: { facilitatorAddress: OUR_SIGNER } }], extensions: [], signers: {} });
    const body = JSON.parse(String(init!.body));
    if (url.endsWith("/verify")) return Response.json({ isValid: true, payer: buyer.address });
    settled.push({ amount: body.paymentRequirements.amount, extensions: body.paymentPayload.extensions });
    return Response.json({ success: true, transaction: `0x${"ab".repeat(32)}`, network: NET, payer: buyer.address, amount: body.paymentRequirements.amount });
  });
});
afterAll(() => void vi.unstubAllGlobals());

function world() {
  const events: SettlementEvent[] = [];
  const seller = createSeller({ sellerAddress: SELLER, network: "arc", settlement: "direct", facilitatorUrl: FACILITATOR, onSettlement: (e) => void events.push(e) });
  seller.route("GET /v1/upto/think", "$0.10", { upto: true, maxTimeoutSeconds: 300, description: "an agent's work, billed by what it spent" });
  const app = new Hono();
  app.use("*", seller.middleware());
  app.get("/v1/upto/think", (c) => {
    if (c.req.query("fail")) return c.json({ error: "the agent could not start" }, 503);
    charge(c, "$0.0213");
    return c.json({ answer: 42 });
  });
  // The buyer: x402's own client for upto, with an Arc USDC it has not yet let Permit2 move.
  const signer = { address: buyer.address, signTypedData: (m: Parameters<typeof buyer.signTypedData>[0]) => buyer.signTypedData(m), readContract: async () => 0n };
  const client = new x402Client().register(NET, new UptoEvmScheme(signer as never));
  client.setSpendControls({ maxAmountPerPayment: false, allowedAssets: [{ network: NET, asset: "0x3600000000000000000000000000000000000000" }] });
  const pay = wrapFetchWithPayment(((input: RequestInfo | URL, init?: RequestInit) => (input instanceof Request ? app.request(input) : app.request(String(input), init))) as typeof fetch, client);
  return { app, pay, events };
}

describe("a route billed by use (x402 upto)", () => {
  it("asks for a ceiling on Arc, bound to our facilitator, and offers the buyer a permit instead of an approval", async () => {
    const res = await world().app.request("http://api.test/v1/upto/think", { headers: { accept: "application/json" } });
    expect(res.status).toBe(402);
    const required = decode(res.headers.get("PAYMENT-REQUIRED"));
    expect(required.accepts).toHaveLength(1);
    expect(required.accepts[0]).toMatchObject({ scheme: "upto", network: NET, amount: "100000", asset: "0x3600000000000000000000000000000000000000", payTo: SELLER, maxTimeoutSeconds: 300 });
    expect(required.accepts[0].extra).toMatchObject({ name: "USDC", version: "2", assetTransferMethod: "permit2", facilitatorAddress: OUR_SIGNER });
    expect(Object.keys(required.extensions ?? {})).toContain("eip2612GasSponsoring");
  });

  it("takes only what the handler charged, with the buyer's permit passed on to be submitted", async () => {
    settled.length = 0;
    const w = world();
    const res = await w.pay("http://api.test/v1/upto/think");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ answer: 42 });
    expect(settled).toHaveLength(1);
    expect(settled[0]!.amount).toBe("21300");
    expect(settled[0]!.extensions?.eip2612GasSponsoring).toMatchObject({ info: { from: buyer.address, spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3", amount: "100000" } });
    expect(decode(res.headers.get("PAYMENT-RESPONSE"))).toMatchObject({ success: true, amount: "21300" });
    expect(res.headers.get("Settlement-Overrides")).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(w.events).toEqual([expect.objectContaining({ outcome: "settled", amount: "21300", payer: buyer.address })]);
  });

  it("takes nothing when the handler fails", async () => {
    settled.length = 0;
    const res = await world().pay("http://api.test/v1/upto/think?fail=1");
    expect(res.status).toBe(503);
    expect(settled).toHaveLength(0);
  });

  it("is refused on a seller that settles through Circle Gateway, which only settles set prices", () => {
    const gateway = createSeller({ sellerAddress: SELLER, network: "arc" });
    expect(() => gateway.route("GET /v1/upto/x", "$0.10", { upto: true })).toThrow(/settlement: "direct"/);
  });
});
