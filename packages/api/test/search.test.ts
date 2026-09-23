import { describe, expect, it } from "vitest";
import { PAID_ROUTES } from "../src/routes.js";
import { exampleUrl, ownItems, pathKey, search, tokens, type SearchItem } from "../src/search.js";

const own = ownItems(PAID_ROUTES, { origin: "https://api.cra-agent.tech", payTo: "0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74", network: "eip155:5042", directPrice: (p) => (Number(p.slice(1)) < 0.003 ? "0.003" : p.slice(1)) });
const top = (q: string, n = 1) => search(own, q, { limit: n }).map((r) => new URL(r.url).pathname);

describe("what an agent finds for a few words", () => {
  it("answers the questions agents ask with the route that sells it", () => {
    expect(top("bitcoin price", 2)).toContain("/v1/paid/market/prices");
    expect(top("btc", 3)).toEqual(expect.arrayContaining(["/v1/paid/market/prices"]));
    expect(top("euro to dollar rate", 3)).toEqual(expect.arrayContaining(["/v1/paid/fx/execution"]));
    expect(top("convert 100 USD to EUR")).toEqual(["/v1/paid/currency/convert"]);
    expect(top("known vulnerabilities in an npm package")).toEqual(["/v1/paid/packages/vulns"]);
    expect(top("what does this wallet hold")).toEqual(["/v1/paid/arc/wallet"]);
    expect(top("gas fee right now", 2)).toEqual(expect.arrayContaining(["/v1/paid/fees/forecast"]));
    expect(top("wikipedia summary")).toEqual(["/v1/paid/wiki/summary"]);
    expect(top("who registered this domain")).toEqual(["/v1/paid/domains/whois"]);
  });

  it("asks for the pair the question names, where the route takes a symbol", () => {
    const fx = (q: string) => search(own, q, { limit: 5 }).find((r) => r.url.includes("/fx/execution"))!;
    expect(new URL(fx("euro to dollar").url).searchParams.get("symbol")).toBe("EURC");
    expect(new URL(fx("bitcoin price").url).searchParams.get("symbol")).toBe("cirBTC");
    expect(new URL(fx("eth price").url).searchParams.get("symbol")).toBe("WETH");
    expect(new URL(fx("eth price").direct!.url).searchParams.get("symbol")).toBe("WETH");
    expect(top("who is building on arc")).toEqual(["/v1/paid/deploys/history"]);
  });

  it("finds nothing rather than something unrelated", () => {
    expect(search(own, "pizza delivery tomorrow")).toEqual([]);
  });

  it("never offers the route that fails on purpose, and respects a price ceiling", () => {
    expect(own.some((i) => i.url.includes("selftest/fail"))).toBe(false);
    const cheap = search(own, "", { maxPriceUsd: 0.001, limit: 50 });
    expect(cheap.length).toBeGreaterThan(0);
    for (const r of cheap) expect(Number(r.priceUsd)).toBeLessThanOrEqual(0.001);
  });

  it("gives a URL an agent can quote as it is, with the parameters it needs and the direct variant", () => {
    const tx = own.find((i) => i.url.includes("/arc/tx"))!;
    expect(tx.url).toMatch(/^https:\/\/api\.cra-agent\.tech\/v1\/paid\/arc\/tx\?hash=0x[0-9a-f]{64}$/);
    expect(tx.params.find((p) => p.name === "hash")).toMatchObject({ required: true });
    expect(tx.direct?.url).toContain("/v1/direct/arc/tx?hash=");
    expect(tx.direct?.priceUsd).toBe("0.003");
    expect(exampleUrl("https://x.io", "/a", [{ name: "q", in: "query", type: "string", description: "", required: true, example: "two words" }])).toBe("https://x.io/a?q=two%20words");
  });

  it("ranks a cheaper seller of the same thing first, and puts ours first on a tie", () => {
    const base = own.find((i) => i.url.includes("/currency/convert"))!;
    const rival: SearchItem = { ...base, url: "https://other.example/convert?from=USD&to=EUR&amount=1", priceUsd: "0.0005", name: "Other", host: "other.example", source: "market", direct: null };
    expect(new URL(search([base, rival], "convert currency")[0]!.url).host).toBe("other.example");
    const tie: SearchItem = { ...rival, priceUsd: base.priceUsd };
    expect(search([tie, base], "convert currency")[0]!.source).toBe("cra-agent");
  });

  it("reads words the way agents write them", () => {
    expect(tokens("What's the BTC/USD price?")).toEqual(["what", "btc", "usd", "price"].filter((t) => t !== "what"));
    expect(pathKey("https://API.cra-agent.tech/v1/paid/x?a=1")).toBe("api.cra-agent.tech/v1/paid/x");
  });
});
