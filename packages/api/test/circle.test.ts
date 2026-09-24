import { describe, expect, it } from "vitest";
import { circleCatalogue, circleItem, circleItems, fetchCircleCatalogue } from "../src/circle.js";
import { PAID_ROUTES } from "../src/routes.js";
import { ownItems, search } from "../src/search.js";

const ARC = "eip155:5042";
const NOW = Date.parse("2026-09-23T12:00:00Z");
const PAY_TO = "0xB98eF29eb2be19Ae646A8FC0248255B90A332dbC";
const GATEWAY = { name: "GatewayWalletBatched", version: "1", verifyingContract: "0x77777777dcc4d5a8b6e418fd04d8997ef11000ee" };

/** An entry shaped like the ones Circle's discovery API returns, with only what is read here. */
const entry = (over: { resource?: string; method?: string; description?: string; amount?: string; payTo?: string; accepts?: unknown[]; input?: unknown; provider?: unknown; lastUpdated?: string } = {}) => ({
  resource: over.resource ?? "https://api.exa.ai/search",
  type: "http",
  x402Version: 2,
  lastUpdated: over.lastUpdated ?? "2026-09-22T18:55:31.971Z",
  accepts: over.accepts ?? [
    { scheme: "exact", network: "eip155:8453", amount: "7000", payTo: PAY_TO, extra: GATEWAY },
    { scheme: "exact", network: ARC, amount: over.amount ?? "7000", payTo: over.payTo ?? PAY_TO, extra: GATEWAY },
  ],
  metadata: {
    provider: over.provider ?? { name: "Exa", description: "AI web search and content extraction for agent retrieval", category: "WEB_SEARCH_RESEARCH", tags: ["x402", "exa", "web-search", "search"] },
    path: "/search",
    method: over.method ?? "POST",
    description: over.description ?? "Search the web with Exa and return ranked results optimized for AI agents.",
    mimeType: "application/json",
    siwx: false,
    supportsVanillax402: false,
    supportsCircleGateway: true,
    ...(over.input === undefined ? {} : { input: over.input }),
  },
});

const contents = entry({
  resource: "https://api.exa.ai/contents",
  description: "Retrieve clean content from URLs",
  amount: "1000",
  accepts: [
    { scheme: "exact", network: ARC, amount: "1000", payTo: PAY_TO, extra: { name: "USDC", version: "2" } },
    { scheme: "exact", network: ARC, amount: "1000", payTo: PAY_TO, extra: GATEWAY },
  ],
  input: {
    type: "http",
    method: "POST",
    bodyType: "json",
    body: {
      type: "object",
      allOf: [
        { type: "object", required: ["urls"], properties: { ids: { type: "array", deprecated: true, description: "Deprecated - use 'urls' instead." }, urls: { type: "array", items: { type: "string" }, example: ["https://arxiv.org/pdf/2307.06435"], description: "Array of URLs to crawl." } } },
        { type: "object", properties: { text: { oneOf: [{ type: "boolean" }, { type: "object" }], description: "Return the page text." }, livecrawl: { type: "string", enum: ["never", "fallback", "always", "preferred", "auto", "fast", "slow"], example: "fallback", description: "When to crawl live." } } },
      ],
    },
  },
});
const webSearch = entry({ input: { type: "http", method: "POST", bodyType: "json", body: { type: "object", required: ["query"], properties: { query: { type: "string", description: "Search query" }, numResults: { type: "number", description: "Number of results to return (max 10 for x402)" } } } } });
const candles = entry({
  resource: "https://nano.blockrun.ai/api/v1/pm/polymarket/candlesticks/{hash}",
  method: "GET",
  description: "Get historical OHLCV candlestick data for a market",
  amount: "1000",
  provider: { name: "BlockRun.AI", description: "AI inference for chat, images, audio, and video", category: "PREDICTION_MARKETS", tags: ["x402", "polymarket"] },
  input: { type: "http", method: "GET", pathParams: { type: "object", properties: { ":hash": { type: "string", description: "path parameter" } } }, queryParams: { type: "object", properties: { interval: { type: "string", example: "1h", description: "Candle size." }, limit: { type: "integer", description: "How many." } } } },
});
const stockQuote = entry({
  resource: "https://nano.blockrun.ai/api/v1/usstock/price/AAPL",
  method: "GET",
  description: "Real-time US stock price quote",
  amount: "3000",
  provider: { name: "BlockRun.AI", description: "Market data", category: "FINANCIAL_ANALYSIS", tags: ["stocks"] },
  input: { type: "http", method: "GET", queryParams: { type: "object", properties: { symbol: { type: "string", example: "AAPL", description: "Ticker." } } } },
});

describe("Circle's catalogue, read as things an agent can buy on Arc", () => {
  it("keeps what the call needs: method, price on Arc, payee, and where each parameter goes", () => {
    const item = circleItem(contents, ARC, NOW)!;
    expect(item).toMatchObject({ url: "https://api.exa.ai/contents", method: "POST", priceUsd: "0.001", name: "Exa", label: "Retrieve clean content from URLs", payTo: PAY_TO.toLowerCase(), host: "api.exa.ai", network: ARC, source: "circle", online: true, direct: null });
    // Our router takes the batched option when both are offered, so that is the rail the agent will use.
    expect(item.rail).toBe("gateway");
    expect(item.networks).toEqual([ARC]);
    // One of its two Arc accepts is a plain USDC transfer: any x402 client can pay it there.
    expect(item.plainNetworks).toEqual([ARC]);
    expect(circleItem(webSearch, ARC, NOW)!.networks).toEqual([ARC, "eip155:8453"]);
    expect(circleItem(webSearch, ARC, NOW)!.plainNetworks).toEqual([]);
    expect(item.params.map((p) => p.name)).toEqual(["urls", "text", "livecrawl"]);
    expect(item.params[0]).toMatchObject({ in: "body", required: true, type: "array of string", example: ["https://arxiv.org/pdf/2307.06435"] });
    expect(item.params[1]!.type).toBe("boolean or object");
    expect(item.params[2]!.description).toBe("When to crawl live. One of: never, fallback, always, preferred, auto, fast, …");
    // Only what is required: an optional example the seller left in could make the call do more.
    expect(item.body).toEqual({ urls: ["https://arxiv.org/pdf/2307.06435"] });
  });

  it("builds no body when the seller gave no example, and still says what is required", () => {
    const item = circleItem(webSearch, ARC, NOW)!;
    expect(item.body).toBeNull();
    expect(item.params.find((p) => p.name === "query")).toMatchObject({ in: "body", required: true });
  });

  it("puts examples in the address and leaves a {placeholder} it has no value for", () => {
    const item = circleItem(candles, ARC, NOW)!;
    expect(item.url).toBe("https://nano.blockrun.ai/api/v1/pm/polymarket/candlesticks/{hash}?interval=1h");
    expect(item.params[0]).toMatchObject({ name: "hash", in: "path", required: true, example: null });
    expect(item.body).toBeNull();
  });

  it("leaves out what an agent could not buy as listed", () => {
    expect(circleItem(entry({ method: "DELETE" }), ARC, NOW)).toBeNull();
    expect(circleItem(entry({ amount: "0" }), ARC, NOW)).toBeNull();
    expect(circleItem(entry({ payTo: "0x123" }), ARC, NOW)).toBeNull();
    expect(circleItem(entry({ resource: "http://api.exa.ai/search" }), ARC, NOW)).toBeNull();
    expect(circleItem(entry({ resource: "not a url" }), ARC, NOW)).toBeNull();
    expect(circleItem(entry({ accepts: [{ scheme: "exact", network: "eip155:8453", amount: "7000", payTo: PAY_TO }] }), ARC, NOW)).toBeNull();
    expect(circleItem(entry(), "eip155:5042002", NOW)).toBeNull();
    expect(circleItem(null, ARC, NOW)).toBeNull();
    expect(circleItem({ resource: 42 }, ARC, NOW)).toBeNull();
  });

  it("marks an entry Circle has not touched in a week as not answering", () => {
    expect(circleItem(entry({ lastUpdated: "2026-09-10T00:00:00Z" }), ARC, NOW)!.online).toBe(false);
    expect(circleItem(entry({ lastUpdated: "whenever" }), ARC, NOW)!.online).toBe(false);
  });

  it("keeps a stranger's text to bounded lines", () => {
    const item = circleItem(entry({ description: `Search\n\n${"x".repeat(500)}`, provider: { name: "  Exa\t", description: 7 } }), ARC, NOW)!;
    expect(item.label).toHaveLength(200);
    expect(item.label!.startsWith("Search x")).toBe(true);
    expect(item.name).toBe("Exa");
    expect(item.description).toBeNull();
  });

  it("counts each call once, and adds the path to a label the seller gave to many of them", () => {
    const proxy = (path: string) => entry({ resource: `https://np.orthogonal.com${path}`, description: "agentmail endpoint via Orthogonal nanopayment proxy", provider: { name: "Orthogonal", description: "Email infrastructure for AI agents" } });
    const items = circleItems([proxy("/agentmail/v0/inboxes"), proxy("/agentmail/v0/inboxes/{inbox_id}/drafts"), proxy("/agentmail/v0/domains"), proxy("/agentmail/v0/domains"), contents], ARC, NOW);
    expect(items).toHaveLength(4);
    expect(items.map((i) => i.label)).toEqual([
      "agentmail endpoint via Orthogonal nanopayment proxy: /agentmail/v0/inboxes",
      "agentmail endpoint via Orthogonal nanopayment proxy: /agentmail/v0/inboxes/{inbox_id}/drafts",
      "agentmail endpoint via Orthogonal nanopayment proxy: /agentmail/v0/domains",
      "Retrieve clean content from URLs",
    ]);
  });
});

describe("searching Circle's catalogue next to our routes", () => {
  const own = ownItems(PAID_ROUTES, { origin: "https://api.cra-agent.tech", payTo: "0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74", network: ARC, directPrice: null });
  const circle = circleItems([contents, webSearch, candles, stockQuote], ARC, NOW);
  const all = [...own, ...circle];

  it("finds a seller we do not know, for what we do not sell", () => {
    expect(search(all, "web search")[0]!.url).toBe("https://api.exa.ai/search");
  });

  it("still answers with our route where we sell the thing", () => {
    expect(new URL(search(all, "bitcoin price")[0]!.url).host).toBe("api.cra-agent.tech");
  });

  it("does not put our pair symbols into another seller's address", () => {
    const quote = search(all, "bitcoin stock price", { limit: 20 }).find((r) => r.host === "nano.blockrun.ai" && r.url.includes("usstock"))!;
    expect(new URL(quote.url).searchParams.get("symbol")).toBe("AAPL");
  });

  it("offers a call the agent can make now before one that needs an id it may not have", () => {
    const ready = { ...circleItem(candles, ARC, NOW)!, url: "https://nano.blockrun.ai/api/v1/pm/polymarket/candlesticks/latest", priceUsd: "0.002" };
    const results = search([circleItem(candles, ARC, NOW)!, ready], "polymarket candlestick");
    expect(results.map((r) => r.url)).toEqual([ready.url, "https://nano.blockrun.ai/api/v1/pm/polymarket/candlesticks/{hash}?interval=1h"]);
  });

  it("does not count a word twice through its synonym", () => {
    const finder = circleItem(entry({ resource: "https://np.orthogonal.com/tomba/v1/email-finder", method: "GET", description: "Find the email address of a person", provider: { name: "Orthogonal", description: "Email finder and verifier" } }), ARC, NOW)!;
    const inbox = circleItem(entry({ resource: "https://api.aisa.one/apis/v2/agentmail/inboxes", description: "Create Inbox", provider: { name: "AIsa API", description: "Email inboxes, threads, and sending for autonomous agents" } }), ARC, NOW)!;
    expect(search([finder, inbox], "email inbox").map((r) => r.host)).toEqual(["api.aisa.one", "np.orthogonal.com"]);
  });

  it("drops results far weaker than the best one", () => {
    const results = search(all, "clean content from urls", { limit: 20 });
    expect(results[0]!.url).toBe("https://api.exa.ai/contents");
    for (const r of results) expect(r.score).toBeGreaterThanOrEqual(results[0]!.score * 0.3);
  });
});

describe("reading the catalogue from Circle", () => {
  const pageOf = (n: number, from: number) => Array.from({ length: n }, (_, i) => entry({ resource: `https://api.example.com/v1/thing/${from + i}` }));
  const serve = (pages: unknown[][], total: number, asked: string[] = []) =>
    (async (u: URL) => {
      asked.push(u.toString());
      const page = pages[Number(u.searchParams.get("offset")) / 100] ?? [];
      return new Response(JSON.stringify({ x402Version: 2, items: page, pagination: { limit: 100, offset: Number(u.searchParams.get("offset")), total } }), { status: 200 });
    }) as unknown as typeof fetch;

  it("reads every page for the network, and stops at the total", async () => {
    const asked: string[] = [];
    const entries = await fetchCircleCatalogue(ARC, { fetchImpl: serve([pageOf(100, 0), pageOf(50, 100)], 150, asked) });
    expect(entries).toHaveLength(150);
    expect(asked).toEqual([
      "https://api.circle.com/v2/x402/discovery/resources?network=eip155%3A5042&limit=100&offset=0",
      "https://api.circle.com/v2/x402/discovery/resources?network=eip155%3A5042&limit=100&offset=100",
    ]);
  });

  it("keeps the last copy when Circle cannot be read, or answers with nothing", async () => {
    let answer: "ok" | "down" | "empty" = "ok";
    const fetchImpl = (async (u: URL) => {
      if (answer === "down") return new Response("unavailable", { status: 503 });
      const items = answer === "ok" ? pageOf(3, 0) : [];
      return new Response(JSON.stringify({ items, pagination: { total: items.length, offset: Number(u.searchParams.get("offset")) } }), { status: 200 });
    }) as unknown as typeof fetch;
    const catalogue = circleCatalogue({ network: ARC, fetchImpl, now: () => NOW });
    expect(catalogue.items()).toEqual([]);
    expect(await catalogue.refresh()).toBe(true);
    expect(catalogue.status()).toEqual({ count: 3, readAt: NOW, error: null });
    answer = "down";
    expect(await catalogue.refresh()).toBe(false);
    expect(catalogue.items()).toHaveLength(3);
    expect(catalogue.status().error).toMatch(/503/);
    answer = "empty";
    expect(await catalogue.refresh()).toBe(false);
    expect(catalogue.items()).toHaveLength(3);
  });

  it("reads once when asked twice at the same time", async () => {
    let reads = 0;
    const fetchImpl = (async () => {
      reads++;
      await new Promise((r) => setTimeout(r, 10));
      return new Response(JSON.stringify({ items: pageOf(1, 0), pagination: { total: 1 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const catalogue = circleCatalogue({ network: ARC, fetchImpl, now: () => NOW });
    await Promise.all([catalogue.refresh(), catalogue.refresh()]);
    expect(reads).toBe(1);
  });
});
