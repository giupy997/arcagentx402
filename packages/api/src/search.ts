/**
 * Search over what an agent can buy on Arc: our own routes, with their parameters, every listing
 * on the market, each of which answered 402 on Arc when it was last checked, and the endpoints
 * Circle's x402 catalogue lists as payable on Arc.
 *
 * Plain word matching, weighted by where the word appears, with a handful of synonyms for the
 * words agents actually use ("btc" for cirBTC, "fee" for gas). No embeddings and no external
 * service: the catalogue is small, the answer has to be explainable, and a result the agent did
 * not ask for costs it a quote.
 */
import type { PaidRoute } from "./routes.js";

/** An example value as the seller gave it: a word or a number, or for a body field a small list or object. */
export type ParamExample = string | number | boolean | null | unknown[] | { [key: string]: unknown };

export interface SearchParam {
  name: string;
  /** Where the value goes: the query string, a {placeholder} in the path, or the JSON body. */
  in: "query" | "path" | "body";
  type: string;
  description: string;
  required: boolean;
  example: ParamExample;
}

export interface SearchItem {
  /** Ready to quote: the route with example values for its parameters. */
  url: string;
  method: "GET" | "POST";
  priceUsd: string;
  /** Who sells it. */
  name: string;
  /** What it is, in plain words, when the seller gave one. */
  label: string | null;
  description: string | null;
  params: SearchParam[];
  payTo: string;
  host: string;
  network: string;
  /** gateway: batched through Circle Gateway. direct: an EIP-3009 authorization a facilitator settles. */
  rail: "gateway" | "direct";
  /** The same route settled directly, for a buyer without a Gateway deposit. */
  direct: { url: string; priceUsd: string } | null;
  /** For a POST, a JSON body of the required fields the seller gave examples for, when it gave any. */
  body: { [key: string]: unknown } | null;
  /** cra-agent: our routes. market: cra-agent.tech/market. circle: Circle's x402 catalogue. */
  source: "cra-agent" | "market" | "circle";
  /** What kind of thing it sells, in a few words, when known. */
  category: string | null;
  /** The seller's own website: for a link, and for its logo. */
  site: string | null;
  online: boolean;
  /** Words that do not show to the agent but count for matching: the route's group and path. */
  keywords: string;
}

export interface SearchResult extends Omit<SearchItem, "keywords"> {
  score: number;
}

const STOP = new Set(["a", "an", "the", "of", "on", "in", "for", "to", "and", "or", "is", "are", "me", "my", "get", "what", "how", "which", "with", "from", "by", "at", "i", "want", "need", "find", "some", "any", "api", "apis", "endpoint", "endpoints", "call", "calls", "paid", "pay"]);

/** Each word also matches these. Kept to the words an agent is likely to use for what is sold here. */
const SYNONYMS: Record<string, readonly string[]> = {
  bitcoin: ["btc", "cirbtc"],
  btc: ["bitcoin", "cirbtc"],
  cirbtc: ["bitcoin", "btc"],
  ether: ["eth", "weth", "ethereum"],
  eth: ["ether", "weth", "ethereum"],
  ethereum: ["eth", "ether", "weth"],
  weth: ["eth", "ether", "ethereum"],
  euro: ["eur", "eurc"],
  eur: ["euro", "eurc"],
  eurc: ["euro", "eur"],
  price: ["prices", "rate", "rates", "executed"],
  prices: ["price", "rate", "rates"],
  rate: ["rates", "price", "exchange"],
  rates: ["rate", "price", "exchange"],
  fee: ["fees", "gas", "cost"],
  fees: ["fee", "gas", "cost"],
  gas: ["fee", "fees", "cost"],
  cost: ["fee", "fees", "gas"],
  currency: ["currencies", "fx", "exchange", "convert"],
  fx: ["currency", "exchange", "rate"],
  exchange: ["fx", "currency", "rate"],
  convert: ["conversion", "currency", "currencies"],
  wallet: ["address", "balance", "balances", "holds"],
  balance: ["balances", "wallet", "holds"],
  transaction: ["tx", "transfer", "transfers"],
  tx: ["transaction", "transfer"],
  token: ["erc", "supply", "symbol"],
  package: ["packages", "npm", "pypi", "library"],
  library: ["package", "packages", "npm", "pypi"],
  vulnerability: ["vulnerabilities", "vulns", "advisories", "security", "cve"],
  vulnerabilities: ["vulnerability", "vulns", "advisories", "security", "cve"],
  security: ["vulns", "advisories", "vulnerability", "holes"],
  cve: ["vulns", "advisories", "vulnerability"],
  domain: ["domains", "dns", "whois", "registrar"],
  dns: ["domain", "domains", "records"],
  whois: ["domain", "registrar", "registered"],
  wikipedia: ["wiki", "article", "encyclopedia"],
  wiki: ["wikipedia", "article"],
  web: ["page", "url", "website", "site"],
  page: ["web", "url", "website"],
  website: ["web", "site", "page", "url"],
  scrape: ["extract", "text", "page"],
  uptime: ["up", "check", "status"],
  contract: ["contracts", "deploy", "deploys", "deployed"],
  deploy: ["deploys", "deployed", "contract", "contracts"],
  rpc: ["endpoint", "node", "provider"],
  stablecoin: ["eurc", "stable"],
  build: ["deploy", "deploys", "deployed", "contracts"],
  building: ["deploy", "deploys", "deployed", "contracts"],
  launched: ["deploy", "deploys", "deployed", "contracts"],
  twitter: ["tweet", "tweets"],
  tweet: ["twitter", "tweets"],
  tweets: ["twitter", "tweet"],
  email: ["mail", "inbox", "inboxes"],
  mail: ["email", "inbox"],
  inbox: ["email", "mail", "inboxes"],
  image: ["images", "picture", "photo"],
  picture: ["image", "images", "photo"],
  stock: ["stocks", "equities", "usstock", "shares"],
  stocks: ["stock", "equities", "usstock", "shares"],
  gpt: ["chat", "completions", "llm", "openai"],
  llm: ["chat", "completions", "model", "models"],
};

export function tokens(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !STOP.has(t)))];
}

/** Whether one of the words of a field matches the query word: exactly, or as the start of a longer word. */
function hit(words: readonly string[], term: string): boolean {
  return words.some((w) => w === term || (term.length >= 4 && w.startsWith(term)) || (w.length >= 4 && term.startsWith(w) && term.length - w.length <= 2));
}

export function scoreItem(item: SearchItem, queryTokens: readonly string[]): number {
  if (queryTokens.length === 0) return 0;
  const fields: Array<[readonly string[], number]> = [
    [tokens(item.label ?? ""), 3],
    [tokens(item.description ?? ""), 2],
    [tokens(item.keywords), 2],
    [tokens(`${item.name} ${item.host}`), 1],
  ];
  let score = 0;
  let matched = 0;
  for (const t of queryTokens) {
    // A synonym that is itself a word of the question already counts as that word: "email inbox" asks for
    // an inbox, and a field that only says "email" should not score for both words.
    const terms = [t, ...(SYNONYMS[t] ?? []).filter((syn) => !queryTokens.includes(syn))];
    let best = 0;
    for (const [words, weight] of fields) {
      // A synonym counts a little less than the word itself.
      if (hit(words, t)) best = Math.max(best, weight);
      else if (terms.slice(1).some((s) => hit(words, s))) best = Math.max(best, weight * 0.75);
    }
    if (best > 0) matched++;
    score += best;
  }
  // Covering every word of the question beats matching one of them many ways.
  return matched === 0 ? 0 : Number((score * (0.5 + (0.5 * matched) / queryTokens.length)).toFixed(3));
}

/** Words that name a pair we price, and the symbol the routes take for it. */
const SYMBOL_OF: Record<string, string> = { bitcoin: "cirBTC", btc: "cirBTC", cirbtc: "cirBTC", ether: "WETH", eth: "WETH", ethereum: "WETH", weth: "WETH", euro: "EURC", eur: "EURC", eurc: "EURC", cra: "CRA" };

/**
 * When the question names a pair and one of our routes takes a symbol, the example URL asks for
 * that pair. Only ours: another seller's "symbol" is its own, and cirBTC means nothing to it.
 */
function withAskedSymbol(item: SearchItem, queryTokens: readonly string[]): SearchItem {
  const asked = queryTokens.map((t) => SYMBOL_OF[t]).find(Boolean);
  if (!asked || item.source !== "cra-agent" || !item.params.some((p) => p.name === "symbol")) return item;
  const swap = (url: string): string => {
    const u = new URL(url);
    u.searchParams.set("symbol", asked);
    return u.toString();
  };
  return { ...item, url: swap(item.url), direct: item.direct ? { ...item.direct, url: swap(item.direct.url) } : null, params: item.params.map((p) => (p.name === "symbol" ? { ...p, example: asked } : p)) };
}

export interface SearchOptions {
  readonly maxPriceUsd?: number;
  readonly limit?: number;
  readonly onlineOnly?: boolean;
  /** Only this seller's endpoints, by name, any case. */
  readonly seller?: string;
  /** Only this category. */
  readonly category?: string;
}

/** On an equal score and price: ours, then what we checked ourselves, then what Circle lists. */
const TIE_ORDER: Record<SearchItem["source"], number> = { "cra-agent": 0, market: 1, circle: 2 };
/** A {placeholder} left in the address: the agent needs an id it may not have before it can call. */
const unfilled = (item: SearchItem): number => (/\{[^}]+\}/.test(item.url) ? 1 : 0);
/** A result far below the best one answers a different question, and trying it costs the agent a quote. */
const RELATIVE_FLOOR = 0.3;

export function search(items: readonly SearchItem[], query: string, opts: SearchOptions = {}): SearchResult[] {
  const q = tokens(query);
  const limit = Math.min(50, Math.max(1, opts.limit ?? 10));
  const seller = opts.seller?.toLowerCase();
  const matching = items
    .filter((i) => (opts.maxPriceUsd === undefined || Number(i.priceUsd) <= opts.maxPriceUsd) && (opts.onlineOnly === false || i.online))
    .filter((i) => (seller === undefined || i.name.toLowerCase() === seller) && (opts.category === undefined || i.category === opts.category))
    .map((i) => ({ item: i, score: scoreItem(i, q) }))
    .filter((r) => q.length === 0 || r.score > 0);
  const best = Math.max(0, ...matching.map((r) => r.score));
  const scored = matching.filter((r) => r.score >= best * RELATIVE_FLOOR);
  scored.sort((a, b) => b.score - a.score || unfilled(a.item) - unfilled(b.item) || Number(a.item.priceUsd) - Number(b.item.priceUsd) || TIE_ORDER[a.item.source] - TIE_ORDER[b.item.source]);
  return scored.slice(0, limit).map(({ item, score }) => {
    const { keywords: _unused, ...rest } = withAskedSymbol(item, q);
    return { ...rest, score };
  });
}

/** A route's URL with example values for the parameters that have one. */
export function exampleUrl(origin: string, path: string, params: readonly SearchParam[]): string {
  const query = params
    .filter((p) => p.example !== null && p.example !== undefined)
    .map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(String(p.example))}`)
    .join("&");
  return `${origin}${path}${query ? `?${query}` : ""}`;
}

/** Our route groups in the words the rest of the catalogue uses, so a category holds everyone's. */
const OUR_CATEGORY: Record<PaidRoute["group"], string> = {
  "Arc network": "Blockchain data",
  "Arc, read live": "Blockchain data",
  Proof: "Blockchain data",
  Currencies: "Financial data",
  "The web": "Web search & research",
  Wikipedia: "Web search & research",
  Packages: "Developer tools",
  Domains: "Developer tools",
};

/** Our own catalogue as search items. The route that fails on purpose is proof, not merchandise, and stays out. */
export function ownItems(routes: readonly PaidRoute[], opts: { origin: string; payTo: string; network: string; directPrice: ((price: string) => string) | null }): SearchItem[] {
  const host = new URL(opts.origin).host;
  return routes
    .filter((r) => !r.alwaysFails)
    .map((r) => {
      const params: SearchParam[] = (r.params ?? []).map((p) => ({ name: p.name, in: "query" as const, type: p.type, description: p.description, required: p.required === true, example: p.example ?? null }));
      const directPath = r.path.replace("/v1/paid", "/v1/direct");
      return {
        url: exampleUrl(opts.origin, r.path, params),
        method: "GET" as const,
        priceUsd: r.price.replace("$", ""),
        name: "CRA AGENT data",
        label: r.plain.label,
        description: r.description,
        params,
        payTo: opts.payTo.toLowerCase(),
        host,
        network: opts.network,
        rail: "gateway" as const,
        direct: opts.directPrice ? { url: exampleUrl(opts.origin, directPath, params), priceUsd: opts.directPrice(r.price) } : null,
        body: null,
        source: "cra-agent" as const,
        category: OUR_CATEGORY[r.group] ?? null,
        site: "https://cra-agent.tech",
        online: true,
        keywords: `${r.group} ${r.path.replace(/[/_-]+/g, " ")} ${r.summary} ${r.plain.explain}`,
      };
    });
}

/** Path identity of a URL, for telling a market listing of one of our routes from the route itself. */
export const pathKey = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
};
