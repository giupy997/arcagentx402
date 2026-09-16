import { describe, expect, it } from "vitest";
import { buildOpenApi } from "../src/openapi.js";
import { PAID_ROUTES } from "../src/routes.js";

const spec = (sellerAddress: string | null = "0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74") =>
  buildOpenApi({ origin: "https://api.cra-agent.tech", network: "eip155:5042", sellerAddress, usdcAddress: "0x3600000000000000000000000000000000000000", version: "0.1.0" }) as any;

describe("the OpenAPI document agents and directories read", () => {
  it("describes every priced route with its price in USDC base units", () => {
    const d = spec();
    for (const r of PAID_ROUTES) {
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
    expect(d.info["x-guidance"].length).toBeGreaterThan(200);
    expect(d.info["x-guidance"].length).toBeLessThan(4000); // their budget for zero-hop guidance
    expect(d.servers[0].url).toBe("https://api.cra-agent.tech");
    for (const r of PAID_ROUTES) expect(d.paths[r.path].get.responses["402"], r.path).toBeTruthy();
  });

  it("never prices a route when there is no seller to pay", () => {
    const d = spec(null);
    for (const r of PAID_ROUTES) expect(d.paths[r.path]).toBeUndefined();
    expect(d.paths["/v1/fx"]).toBeTruthy();
  });

  it("marks the deliberately failing route as failing and nothing else", () => {
    const d = spec();
    expect(d.paths["/v1/paid/selftest/fail"].get.responses["500"]).toBeTruthy();
    expect(d.paths["/v1/paid/selftest/fail"].get.responses["200"]).toBeUndefined();
    expect(d.paths["/v1/paid/fx/execution"].get.responses["200"]).toBeTruthy();
  });
});
