import { x402Client } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { Hono } from "hono";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { charge, createSeller } from "../src/index.js";

const ARC = "eip155:5042";
const BASE = "eip155:8453";
const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const PAY_TO = "0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74";
const SOLANA_PAY_TO = "26SsHut3dRbK9cWUJcrMfkKn3TKXSFMw61zyqm6tgWjK";
const OURS = "https://facilitator.test";
const COINBASE = "https://coinbase.test";
const buyer = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000002");
const decode = (h: string | null) => JSON.parse(Buffer.from(h!, "base64").toString("utf8"));

// Two facilitators, as the API has them: ours for Arc, Coinbase's for Base and Solana, each saying what it settles
// the way the real ones do (checked against Coinbase's /supported on 2026-10-01).
const settledBy: Array<{ by: string; network: string; amount: string }> = [];
beforeAll(() => {
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const by = url.startsWith(OURS) ? "ours" : url.startsWith(COINBASE) ? "coinbase" : null;
    if (!by) return real(input, init);
    if (url.endsWith("/supported"))
      return Response.json(
        by === "ours"
          ? { kinds: [{ x402Version: 2, scheme: "exact", network: ARC }, { x402Version: 2, scheme: "upto", network: ARC, extra: { facilitatorAddress: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf" } }], extensions: [], signers: {} }
          : {
              kinds: [
                { x402Version: 2, scheme: "exact", network: BASE },
                { x402Version: 2, scheme: "upto", network: BASE, extra: { facilitatorAddress: "0x93F6601151cCB08F333AB4B1CCcfb1e188c0bE44" } },
                { x402Version: 2, scheme: "exact", network: SOLANA, extra: { feePayer: "D6ZhtNQ5nT9ZnTHUbqXZsTx5MH2rPFiBBggX4hY1WePM" } },
                { x402Version: 2, scheme: "upto", network: SOLANA, extra: { feePayer: "BENrLoUbndxoNMUS5JXApGMtNykLjFXXixMtpDwDR9SP", receiverAuthorizer: "9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox" } },
              ],
              extensions: ["bazaar", "eip2612GasSponsoring"],
              signers: {},
            },
      );
    const body = JSON.parse(String(init!.body));
    if (url.endsWith("/verify")) return Response.json({ isValid: true, payer: buyer.address });
    settledBy.push({ by, network: body.paymentRequirements.network, amount: body.paymentRequirements.amount });
    return Response.json({ success: true, transaction: `0x${"cd".repeat(32)}`, network: body.paymentRequirements.network, payer: buyer.address, amount: body.paymentRequirements.amount });
  });
});
afterAll(() => void vi.unstubAllGlobals());

function world() {
  const seller = createSeller({
    sellerAddress: PAY_TO,
    network: "arc",
    settlement: "direct",
    facilitatorUrl: OURS,
    discovery: { payTo: PAY_TO, facilitatorUrl: COINBASE, minPrice: "$0.001", tags: ["agent", "llm"], iconUrl: "https://cra-agent.tech/brand/icon-512.png" },
    solana: { payTo: SOLANA_PAY_TO, minPrice: "$0.001" },
  });
  seller.route("GET /v1/upto/think", "$0.10", { upto: true, maxTimeoutSeconds: 300, inputExample: { task: "What moved EURC today?" }, inputSchema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] }, outputExample: { answer: "…", charged: { totalUsdc: "0.0263" } } });
  const app = new Hono();
  app.use("*", seller.middleware());
  app.get("/v1/upto/think", (c) => {
    charge(c, "$0.0263");
    return c.json({ answer: 42 });
  });
  return app;
}

describe("a route billed by use, on Arc, Base and Solana", () => {
  it("offers the same ceiling on the three, each with what its facilitator needs, and asks to be catalogued", async () => {
    const res = await world().request("http://api.test/v1/upto/think?task=hi", { headers: { accept: "application/json" } });
    expect(res.status).toBe(402);
    const required = decode(res.headers.get("PAYMENT-REQUIRED"));
    const [arc, base, solana] = required.accepts as PaymentRequirements[];
    expect(arc).toMatchObject({ scheme: "upto", network: ARC, amount: "100000", payTo: PAY_TO, asset: "0x3600000000000000000000000000000000000000" });
    expect(base).toMatchObject({ scheme: "upto", network: BASE, amount: "100000", payTo: PAY_TO, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", maxTimeoutSeconds: 300 });
    expect(base!.extra).toMatchObject({ name: "USD Coin", version: "2", assetTransferMethod: "permit2", facilitatorAddress: "0x93F6601151cCB08F333AB4B1CCcfb1e188c0bE44" });
    expect(solana).toMatchObject({ scheme: "upto", network: SOLANA, amount: "100000", payTo: SOLANA_PAY_TO, asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" });
    expect(solana!.extra).toMatchObject({ feePayer: "BENrLoUbndxoNMUS5JXApGMtNykLjFXXixMtpDwDR9SP", receiverAuthorizer: "9dpHxn3XFZMZv59vE5MKxhfwGUCCgkcCUzYZLpdEm7ox" });
    expect(Object.keys(required.extensions)).toEqual(expect.arrayContaining(["eip2612GasSponsoring", "bazaar"]));
  });

  it("settles a payment on Base through Coinbase's facilitator, for what the call cost", async () => {
    settledBy.length = 0;
    const app = world();
    const signer = { address: buyer.address, signTypedData: (m: Parameters<typeof buyer.signTypedData>[0]) => buyer.signTypedData(m), readContract: async () => 0n };
    const onBase = (_v: number, accepts: PaymentRequirements[]) => accepts.find((a) => a.network === BASE)!;
    const client = new x402Client(onBase).register(BASE, new UptoEvmScheme(signer as never));
    client.setSpendControls({ maxAmountPerPayment: false });
    const pay = wrapFetchWithPayment(((input: RequestInfo | URL, init?: RequestInit) => (input instanceof Request ? app.request(input) : app.request(String(input), init))) as typeof fetch, client);
    const res = await pay("http://api.test/v1/upto/think?task=hi");
    expect(res.status).toBe(200);
    expect(settledBy).toEqual([{ by: "coinbase", network: BASE, amount: "26300" }]);
  });
});
