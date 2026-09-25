import { describe, expect, it } from "vitest";
import { digestFree, freeTools, isFree, toolAllowed, wantsWeb } from "../src/free-tools.js";

const ARC = "eip155:5042";

describe("free public tools next to what the agent buys", () => {
  it("offers DexScreener for questions about DEX markets and tokens, never for shares", () => {
    const names = (q: string) => freeTools(q, ARC).map((f) => new URL(f.url).pathname);
    expect(names("trending memecoins")).toContain("/token-boosts/top/v1");
    expect(names("dex pairs")[0]).toBe("/latest/dex/search");
    expect(names("newest token launches")).toContain("/token-profiles/latest/v1");
    expect(names("apple stock price")).toEqual([]);
    expect(names("crypto news today")).toEqual([]);
    expect(names("x posts about arc")).toEqual([]);
    expect(names("web search")).toEqual([]);
    const f = freeTools("dex pairs", ARC)[0]!;
    expect(f).toMatchObject({ priceUsd: "0", network: ARC, name: "DexScreener", method: "GET" });
    expect(isFree(f.url)).toBe(true);
    expect(isFree("https://api.exa.ai/search")).toBe(false);
  });

  it("gives the agent pairs by 24-hour volume, not the tiny one that matched first", () => {
    const pair = (symbol: string, chain: string, vol: number) => ({ chainId: chain, dexId: "uniswap", url: `https://dexscreener.com/${chain}/x`, baseToken: { symbol, name: symbol, address: "0xabc" }, quoteToken: { symbol: "WETH" }, priceUsd: "0.0000333", volume: { h24: vol }, liquidity: { usd: 1234.6 }, priceChange: { h24: -4.2 }, marketCap: 99.4 });
    const body = JSON.stringify({ pairs: [pair("PEPE", "robinhood", 71), pair("PEPE", "ethereum", 5_000_000), pair("PEPE", "base", 20_000)] });
    const d = JSON.parse(digestFree("https://api.dexscreener.com/latest/dex/search?q=PEPE", body)!);
    expect(d.pairs).toBe(3);
    expect(d.byVolume24h.map((p: { chain: string }) => p.chain)).toEqual(["ethereum", "base", "robinhood"]);
    expect(d.byVolume24h[0]).toMatchObject({ pair: "PEPE/WETH", volume24hUsd: 5_000_000, liquidityUsd: 1235, change24hPct: -4.2 });
  });

  it("lists boosted tokens by boost, short, and leaves other answers as they came", () => {
    const boosts = JSON.stringify([
      { chainId: "base", tokenAddress: "0x1", description: "small", totalAmount: 10, url: "u1" },
      { chainId: "solana", tokenAddress: "So1", description: "big   one\nhere", totalAmount: 500, url: "u2" },
    ]);
    const d = JSON.parse(digestFree("https://api.dexscreener.com/token-boosts/top/v1", boosts)!);
    expect(d.first[0]).toEqual({ chain: "solana", token: "So1", boosts: 500, about: "big one here", url: "u2" });
    expect(digestFree("https://api.exa.ai/search", boosts)).toBeNull();
    expect(digestFree("https://api.dexscreener.com/token-boosts/top/v1", "<html>")).toBeNull();
  });

  it("knows a search that only the web can answer: news, posts, announcements", () => {
    expect(wantsWeb("crypto news today")).toBe(true);
    expect(wantsWeb("x posts about arc")).toBe(true);
    expect(wantsWeb("what did circle announce")).toBe(true);
    expect(wantsWeb("trending memecoins")).toBe(false);
    expect(wantsWeb("stock price")).toBe(false);
  });

  it("keeps an agent to the tools it was allowed, by URL prefix", () => {
    const only = toolAllowed(["https://api.aisa.one/apis/v2/coingecko/", "https://api.dexscreener.com/"]);
    expect(only("https://api.aisa.one/apis/v2/coingecko/search/trending")).toBe(true);
    expect(only("https://api.aisa.one/apis/v2/agentmail/send")).toBe(false);
    expect(toolAllowed(null)("https://anything.example/x")).toBe(true);
  });
});
