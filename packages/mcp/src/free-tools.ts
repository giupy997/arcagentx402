/**
 * Free public APIs the thinking agent may call next to what it buys: no x402, no key, nothing paid.
 *
 * DexScreener's API is open and rate-limited. Its answers are large and not in the order that matters (a
 * search for PEPE starts with a pair that traded $71 in a day), and the agent reads only the start of what
 * it gets back, so it gets a digest instead: pairs by 24-hour volume with chain, price, volume, liquidity
 * and change; boosted tokens by boost. The page shows the URL that was called, as with anything it buys.
 */
import type { Found } from "./search.js";

const DEX = "https://api.dexscreener.com";

interface FreeTool {
  readonly found: Omit<Found, "network" | "score">;
  /** Words a search matches it by. */
  readonly words: readonly string[];
}

const base = { method: "GET" as const, priceUsd: "0", name: "DexScreener", payTo: "", host: "api.dexscreener.com", rail: "direct" as const, direct: null, source: "free", online: true, body: null };
const MARKET_WORDS = ["dex", "dexscreener", "crypto", "pair", "pairs", "token", "tokens", "coin", "coins", "memecoin", "memecoins", "meme", "liquidity", "volume", "price", "chart", "solana", "base", "ethereum", "bsc", "arbitrum", "hyperliquid", "arc", "pump", "onchain"];
/**
 * Not a question for DEX pairs, whatever else it says: shares (tokenized look-alikes would mislead), and news
 * or posts, which come from searching the web.
 */
const NOT_DEX = ["stock", "stocks", "share", "shares", "equity", "equities", "nasdaq", "nyse", ...["news", "headlines", "post", "posts", "tweet", "tweets", "twitter", "said", "saying", "announce", "announced", "announcement"]];

/** Whether a search asks for what only a web search has: news, posts, announcements. */
export function wantsWeb(query: string): boolean {
  return words(query).some((w) => ["news", "headline", "headlines", "post", "posts", "tweet", "tweets", "twitter", "said", "saying", "announce", "announced", "announcement", "story", "stories"].includes(w));
}

const TOOLS: readonly FreeTool[] = [
  {
    found: {
      ...base,
      url: `${DEX}/latest/dex/search?q=PEPE`,
      label: "Search DEX pairs on every chain by token name, symbol or address: price, 24h volume, liquidity, 24h change",
      description: "DexScreener's free public API",
      params: [{ name: "q", in: "query", type: "string", description: "A token name, symbol or address, or two symbols like WETH USDC", required: true, example: "PEPE" }],
    },
    words: MARKET_WORDS,
  },
  {
    found: {
      ...base,
      url: `${DEX}/token-boosts/top/v1`,
      label: "Tokens with the most active boosts on DexScreener right now (boosts are paid promotion), with chain and description",
      description: "DexScreener's free public API",
      params: [],
    },
    words: ["dex", "dexscreener", "trending", "boost", "boosts", "boosted", "hot", "promoted", "memecoin", "memecoins", "meme", "token", "tokens"],
  },
  {
    found: {
      ...base,
      url: `${DEX}/token-profiles/latest/v1`,
      label: "The newest token profiles on DexScreener: chain, address and what each token says it is",
      description: "DexScreener's free public API",
      params: [],
    },
    words: ["dex", "dexscreener", "new", "newest", "latest", "launch", "launches", "launched", "listing", "listings", "profile", "profiles", "token", "tokens", "memecoin", "memecoins"],
  },
  {
    found: {
      ...base,
      url: `${DEX}/tokens/v1/{chainId}/{tokenAddresses}`,
      label: "Every DEX pair of a token, by chain and contract address: price, 24h volume, liquidity, 24h change",
      description: "DexScreener's free public API",
      params: [
        { name: "chainId", in: "path", type: "string", description: "solana, ethereum, base, bsc, arbitrum, hyperliquid, arc and others", required: true, example: "solana" },
        { name: "tokenAddresses", in: "path", type: "string", description: "One token address, or up to 30 separated by commas", required: true, example: "So11111111111111111111111111111111111111112" },
      ],
    },
    words: ["dex", "dexscreener", "pair", "pairs", "token", "address", "contract", "liquidity", "volume", "price"],
  },
];

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);

/** The free tools a search's words point to, best first: none when the question is not about DEX markets. */
export function freeTools(query: string, network: string): Found[] {
  const asked = words(query);
  if (asked.some((a) => NOT_DEX.includes(a))) return [];
  const hits = (w: string) => asked.some((a) => a === w || (a.length >= 4 && w.length >= 4 && (a.startsWith(w) || w.startsWith(a))));
  return TOOLS.map((t) => ({ t, score: t.words.filter(hits).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ t, score }) => ({ ...t.found, params: t.found.params.map((p) => ({ ...p })), network, score }));
}

export const isFree = (url: string): boolean => url.startsWith(`${DEX}/`);

type Pair = { chainId?: string; dexId?: string; url?: string; baseToken?: { symbol?: string; name?: string; address?: string }; quoteToken?: { symbol?: string }; priceUsd?: string; volume?: { h24?: number }; liquidity?: { usd?: number }; priceChange?: { h24?: number }; marketCap?: number };
type Listed = { chainId?: string; tokenAddress?: string; description?: string; url?: string; totalAmount?: number; amount?: number };

const round = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n) : null);

/** What the agent reads of a free tool's answer: the parts that answer questions, most important first. Null: as it came. */
export function digestFree(url: string, body: string): string | null {
  if (!isFree(url)) return null;
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  const pairs = (data as { pairs?: Pair[] | null })?.pairs ?? (Array.isArray(data) && (data[0] as Pair | undefined)?.baseToken ? (data as Pair[]) : null);
  if (pairs) {
    const byVolume = [...pairs].sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0)).slice(0, 8);
    return JSON.stringify({
      pairs: pairs.length,
      byVolume24h: byVolume.map((p) => ({
        chain: p.chainId,
        dex: p.dexId,
        pair: `${p.baseToken?.symbol ?? "?"}/${p.quoteToken?.symbol ?? "?"}`,
        name: p.baseToken?.name,
        token: p.baseToken?.address,
        priceUsd: p.priceUsd,
        volume24hUsd: round(p.volume?.h24),
        liquidityUsd: round(p.liquidity?.usd),
        change24hPct: p.priceChange?.h24 ?? null,
        marketCapUsd: round(p.marketCap),
        url: p.url,
      })),
    });
  }
  if (Array.isArray(data)) {
    const listed = (data as Listed[]).slice().sort((a, b) => (b.totalAmount ?? b.amount ?? 0) - (a.totalAmount ?? a.amount ?? 0)).slice(0, 10);
    return JSON.stringify({
      tokens: data.length,
      first: listed.map((t) => ({ chain: t.chainId, token: t.tokenAddress, boosts: t.totalAmount ?? t.amount ?? null, about: (t.description ?? "").replace(/\s+/g, " ").slice(0, 90), url: t.url })),
    });
  }
  return null;
}

/** Whether a URL is one the agent may use, given the URL prefixes it was allowed (none given: all). */
export function toolAllowed(prefixes: readonly string[] | null): (url: string) => boolean {
  return (url) => prefixes === null || prefixes.some((p) => url.startsWith(p));
}
