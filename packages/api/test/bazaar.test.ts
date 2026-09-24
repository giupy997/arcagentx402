import { describe, expect, it } from "vitest";
import { bazaarOverview, familyOf, iconCandidates, logoFetcher, sniffImage } from "../src/bazaar.js";
import type { Catalogue } from "../src/market.js";
import type { Fetched } from "../src/safe-fetch.js";
import type { SearchItem } from "../src/search.js";

const item = (over: Partial<SearchItem>): SearchItem => ({
  url: "https://api.exa.ai/search",
  method: "POST",
  priceUsd: "0.007",
  name: "Exa",
  label: "Search the web",
  description: "AI web search and content extraction for agent retrieval",
  params: [],
  payTo: "0xb98ef29eb2be19ae646a8fc0248255b90a332dbc",
  host: "api.exa.ai",
  network: "eip155:5042",
  rail: "gateway",
  direct: null,
  body: null,
  source: "circle",
  category: "Web search & research",
  site: "https://exa.ai",
  networks: ["eip155:5042", "eip155:8453"],
  plainNetworks: [],
  online: true,
  keywords: "",
  ...over,
});
const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

describe("the bazaar, by seller", () => {
  it("reads what an endpoint sells from its path, past the plumbing", () => {
    expect(familyOf("https://np.orthogonal.com/agentmail/v0/inboxes/{inbox_id}")).toBe("agentmail");
    expect(familyOf("https://api.aisa.one/apis/v2/coingecko/simple/price")).toBe("coingecko");
    expect(familyOf("https://api.cra-agent.tech/v1/paid/fx/execution?symbol=EURC")).toBe("fx");
    expect(familyOf("https://edge.goldsky.com/standard/evm/1")).toBeNull();
    expect(familyOf("not a url")).toBeNull();
  });

  it("groups endpoints by seller, ours first, with prices, families and what most of them say", () => {
    const cat: Catalogue = {
      own: [
        item({ url: "https://api.cra-agent.tech/v1/paid/fx/execution", name: "CRA AGENT data", source: "cra-agent", priceUsd: "0.001", category: "Financial data", site: "https://cra-agent.tech", description: "Executed price", networks: ["eip155:5042", "eip155:8453", SOLANA], plainNetworks: ["eip155:8453", SOLANA] }),
        item({ url: "https://api.cra-agent.tech/v1/paid/arc/tx", name: "CRA AGENT data", source: "cra-agent", priceUsd: "0.003", category: "Blockchain data", site: "https://cra-agent.tech", description: "A transaction", rail: "direct", networks: ["eip155:5042", "eip155:8453", SOLANA], plainNetworks: ["eip155:5042", "eip155:8453", SOLANA] }),
      ],
      market: [],
      circle: [
        item({}),
        item({ url: "https://api.exa.ai/contents", priceUsd: "0.001" }),
        item({ url: "https://np.orthogonal.com/agentmail/v0/inboxes", name: "Orthogonal", priceUsd: "2", category: "Infrastructure", site: "https://www.orthogonal.com", description: "Email infrastructure for AI agents", networks: ["eip155:5042"] }),
        item({ url: "https://np.orthogonal.com/apollo/api/v1/people/match", name: "Orthogonal", priceUsd: "0.01", category: "Data enrichment", site: "https://www.orthogonal.com", description: "Contact and company data" }),
        item({ url: "https://np.orthogonal.com/apollo/api/v1/organizations/search", name: "Orthogonal", priceUsd: "0.02", category: "Data enrichment", site: "https://www.orthogonal.com", description: "Contact and company data" }),
      ],
      circleReadAt: 1790200000,
    };
    const b = bazaarOverview(cat, "eip155:5042");
    expect(b.counts).toEqual({ endpoints: 7, sellers: 3, categories: 5 });
    expect(b.sellers.map((s) => s.name)).toEqual(["CRA AGENT data", "Orthogonal", "Exa"]);
    const [ours, orthogonal, exa] = b.sellers;
    expect(ours).toMatchObject({ logo: null, rail: "both", priceFrom: "0.001", priceTo: "0.003", families: ["fx", "arc"] });
    expect(ours!.description).toMatch(/Arc network data/);
    // Two of three say "Contact and company data", but only about apollo: not a sentence for all of Orthogonal.
    expect(orthogonal).toMatchObject({ description: null, families: ["apollo", "agentmail"], familyCount: 2, priceFrom: "0.01", priceTo: "2", categories: ["Data enrichment", "Infrastructure"], logo: "/v1/bazaar/logo?site=https%3A%2F%2Fwww.orthogonal.com" });
    expect(exa).toMatchObject({ description: "AI web search and content extraction for agent retrieval", families: ["search", "contents"], endpoints: 2 });
    expect(b.categories[0]).toEqual({ name: "Web search & research", endpoints: 2, sellers: 1 });
    // What an agent on each network can buy here: Arc everything, Base all but one, Solana only ours.
    // "plain": how many take a payment from any x402 client there, rather than through Circle Gateway only.
    expect(b.networks).toEqual([
      { id: "eip155:5042", name: "Arc", endpoints: 7, sellers: 3, plain: 1 },
      { id: "eip155:8453", name: "Base", endpoints: 6, sellers: 3, plain: 2 },
      { id: SOLANA, name: "Solana", endpoints: 2, sellers: 1, plain: 2 },
    ]);
    expect(ours!.networks).toEqual(["eip155:5042", "eip155:8453", SOLANA]);
    expect(ours!.plainNetworks).toEqual(["eip155:5042", "eip155:8453", SOLANA]);
    expect(orthogonal!.plainNetworks).toEqual([]);
    expect(orthogonal!.networks).toEqual(["eip155:5042", "eip155:8453"]);
  });
});

describe("sellers' logos", () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120)]);

  it("knows a raster image by its bytes, and refuses SVG and pages", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]))).toBe("image/jpeg");
    expect(sniffImage(Buffer.from("GIF89a" + "x".repeat(20)))).toBe("image/gif");
    expect(sniffImage(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(10)]))).toBe("image/webp");
    expect(sniffImage(Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.alloc(30)]))).toBe("image/x-icon");
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(sniffImage(Buffer.from("<!doctype html><html>"))).toBeNull();
  });

  it("picks a page's best icon: the touch icon, then the largest, never an SVG, then the usual places", () => {
    const html = `<head>
      <link rel="icon" href="/favicon-16.png" sizes="16x16">
      <link rel="icon" type="image/svg+xml" href="/icon.svg">
      <link rel='shortcut icon' href='https://cdn.exa.ai/icon-64.png' sizes='64x64'>
      <link rel="apple-touch-icon" href="touch.png">
      <link rel="stylesheet" href="/style.css">
    </head>`;
    expect(iconCandidates(html, "https://exa.ai/")).toEqual([
      "https://exa.ai/touch.png",
      "https://cdn.exa.ai/icon-64.png",
      "https://exa.ai/favicon-16.png",
      "https://exa.ai/apple-touch-icon.png",
      "https://exa.ai/favicon.ico",
    ]);
    expect(iconCandidates("", "https://goldsky.com")).toEqual(["https://goldsky.com/apple-touch-icon.png", "https://goldsky.com/favicon.ico"]);
  });

  it("reads a logo once, keeps it, and keeps a miss for a while too", async () => {
    const asked: string[] = [];
    const answer = (status: number, body: Buffer | string, finalUrl: string): Fetched => ({ finalUrl, status, headers: {}, body: Buffer.isBuffer(body) ? body : Buffer.from(body), truncated: false, hops: [] });
    let t = 0;
    const logo = logoFetcher({
      now: () => t,
      fetch: async (url) => {
        asked.push(url);
        if (url === "https://exa.ai") return answer(200, '<link rel="icon" href="/logo.png">', "https://exa.ai/");
        if (url === "https://exa.ai/logo.png") return answer(200, PNG, url);
        return answer(404, "", url);
      },
    });
    expect((await logo("https://exa.ai"))?.type).toBe("image/png");
    expect(await logo("https://exa.ai")).not.toBeNull();
    expect(asked).toEqual(["https://exa.ai", "https://exa.ai/logo.png"]);
    expect(await logo("https://nologo.example")).toBeNull();
    const before = asked.length;
    t += 3_600_000;
    expect(await logo("https://nologo.example")).toBeNull();
    expect(asked.length).toBe(before);
  });
});
