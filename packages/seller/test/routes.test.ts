import { describe, expect, it } from "vitest";
import { BASE_MAINNET, buildRoutes, resolveNetwork, type SellerConfig } from "../src/index.js";

const SELLER = "0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74";
const base: SellerConfig = { sellerAddress: SELLER, network: "arc", serviceName: "CRA AGENT data" };
const withRail: SellerConfig = {
  ...base,
  discovery: { payTo: SELLER, cdpKeyId: "id", cdpKeySecret: "secret", tags: ["arc"], iconUrl: "https://cra-agent.tech/brand/favicon-32.png" },
};
const arc = resolveNetwork(base).network;

describe("what a priced route advertises", () => {
  it("takes a facilitator that needs no credentials", () => {
    const open: SellerConfig = { ...base, discovery: { payTo: SELLER, facilitatorUrl: "https://facilitator.example/x402" } };
    const r = buildRoutes(open, arc, "GET /v1/paid/x", "$0.001", {});
    expect((r.accepts as any[]).map((a) => a.network)).toEqual(["eip155:5042", BASE_MAINNET]);
    expect((r as any).extensions).toBeTruthy();
  });

  it("offers Arc alone when there is no discovery rail", () => {
    const r = buildRoutes(base, arc, "GET /v1/paid/x", "$0.001", {});
    expect(Array.isArray(r.accepts)).toBe(false);
    expect((r.accepts as any).network).toBe("eip155:5042");
    expect((r as any).extensions).toBeUndefined();
  });

  it("offers both rails at the same price when the rail is configured", () => {
    const r = buildRoutes(withRail, arc, "GET /v1/paid/x", "$0.001", {});
    const accepts = r.accepts as any[];
    expect(accepts.map((a) => a.network)).toEqual(["eip155:5042", BASE_MAINNET]);
    expect(new Set(accepts.map((a) => a.price))).toEqual(new Set(["$0.001"]));
    expect(accepts.every((a) => a.scheme === "exact")).toBe(true);
  });

  it("declares for the catalogue what the route takes and returns", () => {
    const inputSchema = { type: "object", properties: { window: { type: "integer" } } };
    const r = buildRoutes(withRail, arc, "GET /v1/paid/fx/execution", "$0.001", { inputSchema, outputExample: { pair: "EURC/USDC" } });
    const ext = (r as any).extensions;
    expect(Object.keys(ext).length).toBeGreaterThan(0);
    expect(JSON.stringify(ext)).toContain("window");
    expect(JSON.stringify(ext)).toContain("EURC/USDC");
    expect((r as any).tags).toEqual(["arc"]);
    expect((r as any).iconUrl).toMatch(/^https:/);
  });

  it("keeps the preview body and the description on both rails", () => {
    const r = buildRoutes(withRail, arc, "GET /v1/paid/x", "$0.001", { description: "d", preview: { hint: "h" } });
    expect(r.description).toBe("d");
    expect(r.serviceName).toBe("CRA AGENT data");
    expect(typeof r.unpaidResponseBody).toBe("function");
  });
});
