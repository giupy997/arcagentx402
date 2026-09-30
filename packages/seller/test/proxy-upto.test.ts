import { x402Client } from "@x402/core/client";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createProxyApp, uptoCharge } from "../src/proxy.js";
import { parseSellArgs } from "../src/sell-args.js";

const NET = "eip155:5042";
const PAY_TO = "0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74";
const FACILITATOR = "https://facilitator.test";
const buyer = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000002");
const decode = (h: string | null) => JSON.parse(Buffer.from(h!, "base64").toString("utf8"));

// The facilitator, played here: it lists upto on Arc, passes every payment, and settles what it is told.
const settled: string[] = [];
beforeAll(() => {
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith(FACILITATOR)) return real(input, init);
    if (url.endsWith("/supported")) return Response.json({ kinds: [{ x402Version: 2, scheme: "exact", network: NET }, { x402Version: 2, scheme: "upto", network: NET, extra: { facilitatorAddress: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf" } }], extensions: [], signers: {} });
    const body = JSON.parse(String(init!.body));
    if (url.endsWith("/verify")) return Response.json({ isValid: true, payer: buyer.address });
    settled.push(body.paymentRequirements.amount);
    return Response.json({ success: true, transaction: `0x${"ab".repeat(32)}`, network: NET, payer: buyer.address, amount: body.paymentRequirements.amount });
  });
});
afterAll(() => void vi.unstubAllGlobals());

/** A seller's API that reports what each call cost, the paywall in front of it, and a buyer paying with x402's upto client. */
function world(charge: string | null, extra: Record<string, string> = {}) {
  const upstream = (async () => new Response(JSON.stringify({ rendered: true }), { status: 200, headers: { "content-type": "application/json", ...(charge === null ? {} : { "X-Charge-USD": charge }), ...extra } })) as typeof fetch;
  const app = createProxyApp({ target: "https://api.example.com", payTo: PAY_TO, network: "arc", routes: [{ pattern: "/*", price: "0.10" }], free: ["/health"], facilitatorUrl: FACILITATOR, upto: true, fetch: upstream });
  const signer = { address: buyer.address, signTypedData: (m: Parameters<typeof buyer.signTypedData>[0]) => buyer.signTypedData(m), readContract: async () => 0n };
  const client = new x402Client().register(NET, new UptoEvmScheme(signer as never));
  client.setSpendControls({ maxAmountPerPayment: false, allowedAssets: [{ network: NET, asset: "0x3600000000000000000000000000000000000000" }] });
  const pay = wrapFetchWithPayment(((input: RequestInfo | URL, init?: RequestInit) => (input instanceof Request ? app.request(input) : app.request(String(input), init))) as typeof fetch, client);
  return { app, pay };
}

describe("cra-agent-sell --upto: billed by what the API says a call cost", () => {
  it("asks for the price as a ceiling, on Arc, and says how it bills", async () => {
    const { app } = world("0.01");
    const res = await app.request("http://seller.test/v1/render?scene=1", { headers: { accept: "application/json" } });
    expect(res.status).toBe(402);
    expect(decode(res.headers.get("PAYMENT-REQUIRED")).accepts).toEqual([expect.objectContaining({ scheme: "upto", network: NET, amount: "100000", payTo: PAY_TO, maxTimeoutSeconds: 300 })]);
    const doc = await (await app.request("http://seller.test/.well-known/x402")).json();
    expect(doc.billing).toMatch(/^upto/);
    expect(doc.routes[0]).toMatchObject({ scheme: "upto", ceilingUsd: "0.10" });
  });

  it("takes what the API reported, and the buyer never sees the header", async () => {
    settled.length = 0;
    const res = await world("0.0123").pay("http://seller.test/v1/render?scene=1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rendered: true });
    expect(settled).toEqual(["12300"]);
    expect(res.headers.get("X-Charge-USD")).toBeNull();
    expect(res.headers.get("Settlement-Overrides")).toBeNull();
  });

  it("takes the ceiling when the API says nothing, and never more than it when it says more", async () => {
    settled.length = 0;
    await world(null).pay("http://seller.test/v1/render");
    await world("0.5").pay("http://seller.test/v1/render");
    expect(settled).toEqual(["100000", "100000"]);
  });

  it("never lets the API behind set the settlement itself", async () => {
    const { app } = world(null, { "Settlement-Overrides": JSON.stringify({ amount: "1" }) });
    const res = await app.request("http://seller.test/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("Settlement-Overrides")).toBeNull();
  });

  it("reads a charge in dollars, capped at the ceiling; anything else takes the ceiling", () => {
    expect(uptoCharge("0.0123", "$0.10")).toBe(12_300n);
    expect(uptoCharge(" $0.0123 ", "0.10")).toBe(12_300n);
    expect(uptoCharge("0", "0.10")).toBe(0n);
    expect(uptoCharge("1", "0.10")).toBe(100_000n);
    for (const bad of [null, "", "-1", "abc", "1e-3", "0.0000001"]) expect(uptoCharge(bad, "0.10"), String(bad)).toBeNull();
  });

  it("needs a facilitator that settles upto, and keeps Solana and Lightning out", () => {
    const base = ["--target", "https://api.example.com", "--pay-to", PAY_TO, "--price", "0.10", "--upto"];
    expect(parseSellArgs([...base, "--facilitator", "cra"])).toMatchObject({ upto: true, facilitatorUrl: "https://api.cra-agent.tech/facilitator" });
    expect(parseSellArgs(base.filter((a) => a !== "--upto").concat("--facilitator", "cra")).upto).toBe(false);
    expect(() => parseSellArgs(base)).toThrow(/--facilitator cra/);
    expect(() => parseSellArgs([...base, "--facilitator", "cra", "--pay-to-solana", "26SsHut3dRbK9cWUJcrMfkKn3TKXSFMw61zyqm6tgWjK"])).toThrow(/Arc only/);
    expect(() => createProxyApp({ target: "https://api.example.com", payTo: PAY_TO, network: "arc", routes: [{ pattern: "/*", price: "0.10" }], upto: true })).toThrow(/--facilitator cra/);
  });
});
