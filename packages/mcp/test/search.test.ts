import { describe, expect, it } from "vitest";
import { parseUsdc6, usdc6 } from "@cra-agent/accounting";
import { parsePolicyString } from "@cra-agent/policy";
import { fit, forAgent, NOTHING_SPENT, searchMarket, type Found } from "../src/search.js";

const ARC = "eip155:5042";
const found = (over: Partial<Found> = {}): Found => ({
  url: "https://api.cra-agent.tech/v1/paid/market/prices",
  method: "GET",
  priceUsd: "0.002",
  name: "CRA AGENT data",
  label: "Bitcoin, Ether, euro and CRA prices on Arc, in one call",
  description: "All pairs...",
  params: [],
  payTo: "0x33b37c6d7a98b58da3ccb3f36a4b578053d0ea74",
  host: "api.cra-agent.tech",
  network: ARC,
  rail: "gateway",
  direct: { url: "https://api.cra-agent.tech/v1/direct/market/prices", priceUsd: "0.003" },
  source: "cra-agent",
  online: true,
  score: 6,
  ...over,
});

describe("what the agent is told about a search result", () => {
  it("says yes when the limits allow it, and which address to call", () => {
    const f = fit(found(), parsePolicyString("daily=1,per_payment=0.01"), ARC, NOTHING_SPENT, "0.5");
    expect(f).toEqual({ url: found().url, priceUsd: "0.002", payable: true });
  });

  it("sends an agent with no Gateway balance to the direct address, at its own price", () => {
    const f = fit(found(), parsePolicyString("daily=1,per_payment=0.01"), ARC, NOTHING_SPENT, "0");
    expect(f).toMatchObject({ url: found().direct!.url, priceUsd: "0.003", payable: true });
    // And one with no direct address stays where it is: the payment will tell it to deposit.
    expect(fit(found({ direct: null }), parsePolicyString(""), ARC, NOTHING_SPENT, "0").url).toBe(found().url);
  });

  it("names the rule that would stop the payment, the way paying would", () => {
    expect(fit(found(), parsePolicyString("allow=other.example"), ARC, NOTHING_SPENT, "1")).toMatchObject({ payable: false, rule: "allowlist" });
    expect(fit(found({ priceUsd: "0.05" }), parsePolicyString("per_payment=0.01"), ARC, NOTHING_SPENT, "1")).toMatchObject({ payable: false, rule: "per_payment" });
    const spent = { day: parseUsdc6("0.999"), withSeller: () => usdc6(0n), inRateWindow: 0 };
    expect(fit(found(), parsePolicyString("daily=1,per_seller=1"), ARC, spent, "1")).toMatchObject({ payable: false, rule: "daily" });
    expect(fit(found(), parsePolicyString(""), "eip155:5042002", NOTHING_SPENT, "1")).toMatchObject({ payable: false, rule: "network" });
  });

  it("keeps what the agent reads short, and leaves out the verdict when there is no agent to judge for", () => {
    const long = found({ label: null, description: "x".repeat(400) });
    expect(forAgent(long, null).what).toHaveLength(200);
    expect(forAgent(long, null)).not.toHaveProperty("payable");
    expect(forAgent(found(), { url: "u", priceUsd: "0.002", payable: false, rule: "daily", reason: "cap" })).toMatchObject({ payable: false, whyNot: "daily: cap" });
  });

  it("asks the market with the query, the ceiling and the limit", async () => {
    let asked = "";
    const fetchImpl = (async (u: URL) => {
      asked = u.toString();
      return new Response(JSON.stringify({ query: "btc", network: ARC, count: 0, results: [], note: "" }), { status: 200 });
    }) as unknown as typeof fetch;
    await searchMarket("btc price", { maxUsdc: "0.01", limit: 3, api: "https://example.test", fetchImpl });
    expect(asked).toBe("https://example.test/v1/market/search?q=btc+price&maxPriceUsd=0.01&limit=3");
  });
});
