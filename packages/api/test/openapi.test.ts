import { describe, expect, it } from "vitest";
import { buildOpenApi, type OpenApiOptions } from "../src/openapi.js";
import { PAID_ROUTES } from "../src/routes.js";

const PAY_TO = "0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74";
const spec = (sellerAddress: string | null = PAY_TO, more: Partial<OpenApiOptions> = {}) =>
  buildOpenApi({ origin: "https://api.cra-agent.tech", network: "eip155:5042", sellerAddress, usdcAddress: "0x3600000000000000000000000000000000000000", version: "0.1.0", ...more }) as any;
// Base and Solana as the API has them: Coinbase's facilitator settles both and refuses less than $0.001.
const BASE = { network: "eip155:8453", name: "Base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAY_TO, minPrice: "$0.001" };
const SOLANA = { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", name: "Solana", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", payTo: "26SsHut3dRbK9cWUJcrMfkKn3TKXSFMw61zyqm6tgWjK", minPrice: "$0.001" };
const UPTO = { ceilingUsdc: "0.10", feeUsdc: "0.005" };

describe("the OpenAPI document agents and directories read", () => {
  it("describes every priced route with its price in USDC base units", () => {
    const d = spec();
    for (const r of PAID_ROUTES.filter((x) => !x.alwaysFails)) {
      const info = d.paths[r.path]?.get?.["x-payment-info"];
      expect(info, r.path).toBeTruthy();
      expect(info.price.mode).toBe("fixed");
      expect(info.price.amount).toBe(r.price.replace("$", ""));
      const x402 = info.protocols[0].x402;
      expect(x402.amount).toBe(String(Math.round(Number(r.price.slice(1)) * 1e6)));
      expect(x402.network).toBe("eip155:5042");
      expect(x402.payTo).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it("answers the checks a directory makes: contact, guidance, servers, a 402 on every paid route", () => {
    const d = spec();
    expect(d.info.contact.url).toMatch(/^https:/);
    expect(d.info.termsOfService).toBe("https://cra-agent.tech/terms");
    expect(d.info["x-guidance"].length).toBeGreaterThan(200);
    expect(d.info["x-guidance"].length).toBeLessThan(4000); // their budget for zero-hop guidance
    expect(d.servers[0].url).toBe("https://api.cra-agent.tech");
    for (const r of PAID_ROUTES.filter((x) => !x.alwaysFails)) expect(d.paths[r.path].get.responses["402"], r.path).toBeTruthy();
  });

  it("never prices a route when there is no seller to pay", () => {
    const d = spec(null);
    for (const r of PAID_ROUTES) expect(d.paths[r.path]).toBeUndefined();
    expect(d.paths["/v1/fx"]).toBeTruthy();
  });

  it("leaves the route that fails on purpose out, and nothing else", () => {
    const d = spec();
    // The route that fails on purpose is not offered to catalogues.
    expect(d.paths["/v1/paid/selftest/fail"]).toBeUndefined();
    expect(d.paths["/v1/paid/fx/execution"].get.responses["200"]).toBeTruthy();
  });

  it("prices the thinking agent as a range, paid with upto, only when it runs here", () => {
    const off = spec();
    expect(off.paths["/v1/upto/think"]).toBeUndefined();
    expect(off.info["x-guidance"]).not.toMatch(/upto/);
    const on = spec(PAY_TO, { upto: UPTO });
    const op = on.paths["/v1/upto/think"].get;
    expect(op["x-payment-info"].price).toEqual({ mode: "dynamic", currency: "USD", min: "0.005", max: "0.10" });
    expect(op["x-payment-info"].protocols[0].x402).toMatchObject({ scheme: "upto", amount: "100000", maxTimeoutSeconds: 300 });
    expect(op.parameters[0]).toMatchObject({ name: "task", required: true });
    expect(op.responses["402"]).toBeTruthy();
    expect(on.info.description).toMatch(/research agent billed by use at \/v1\/upto\/think/);
  });

  it("prices every route on each network it is paid on, never under the minimum of the facilitator there", () => {
    const d = spec(PAY_TO, { plain: [BASE, SOLANA] });
    // $0.0005 on Arc, which Coinbase's facilitator would refuse: the 402 asks $0.001 on Base and Solana.
    const cheap = d.paths["/v1/paid/fees/estimate"].get;
    expect(cheap["x-payment-info"].protocols.map((p: any) => [p.x402.scheme, p.x402.network, p.x402.amount, p.x402.payTo])).toEqual([
      ["exact", "eip155:5042", "500", PAY_TO],
      ["exact", BASE.network, "1000", PAY_TO],
      ["exact", SOLANA.network, "1000", SOLANA.payTo],
    ]);
    expect(cheap.responses["402"].description).toBe("Payment required: $0.0005 in USDC on Arc, $0.001 on Base or Solana. Requirements are in the payment-required header.");
    expect(d.paths["/v1/paid/wiki/summary"].get.responses["402"].description).toMatch(/^Payment required: \$0\.001 in USDC on Arc, Base or Solana\./);
    const think = spec(PAY_TO, { plain: [BASE, SOLANA], upto: UPTO }).paths["/v1/upto/think"].get;
    expect(think["x-payment-info"].protocols.map((p: any) => [p.x402.scheme, p.x402.network, p.x402.amount])).toEqual([
      ["upto", "eip155:5042", "100000"],
      ["upto", BASE.network, "100000"],
      ["upto", SOLANA.network, "100000"],
    ]);
  });

  it("tells an agent every way to pay that is on, and none that is off", () => {
    const all = spec(PAY_TO, { plain: [BASE, SOLANA], upto: UPTO, direct: { floorUsdc: "0.003" } });
    expect(all.info.description).toMatch(/^Data for agents by the call, paid in USDC over x402 on Arc, Base or Solana: /);
    expect(all.info["x-guidance"]).toMatch(/Arc through Circle Gateway .*, or Base or Solana with a plain x402 payment, where a call costs at least \$0\.001\./);
    expect(all.info["x-guidance"]).toMatch(/\/v1\/direct for a direct EIP-3009 payment on Arc .* at \$0\.003 or more a call/);
    expect(all.info["x-guidance"]).toMatch(/hires our thinking agent over x402 upto, on Arc, Base or Solana: you sign once for up to \$0\.10/);
    expect(all.info["x-guidance"].length).toBeLessThan(4000);
    expect(all.tags.find((t: any) => t.name === "paid").description).toBe("Priced per call, paid over x402 in USDC on Arc, Base or Solana.");
    const arcOnly = spec();
    expect(arcOnly.info.description).toMatch(/over x402 on Arc: /);
    expect(arcOnly.info["x-guidance"]).not.toMatch(/Base|Solana|\/v1\/direct/);
    expect(arcOnly.paths["/v1/paid/fees/estimate"].get.responses["402"].description).toMatch(/^Payment required: \$0\.0005 in USDC on Arc\./);
  });
});
