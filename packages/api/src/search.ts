/**
 * Search over what an agent can buy on Arc: our own routes, with their parameters, and every
 * listing on the market, each of which answered 402 on Arc when it was last checked.
 *
 * Plain word matching, weighted by where the word appears, with a handful of synonyms for the
 * words agents actually use ("btc" for cirBTC, "fee" for gas). No embeddings and no external
 * service: the catalogue is small, the answer has to be explainable, and a result the agent did
 * not ask for costs it a quote.
 */
import type { PaidRoute } from "./routes.js";

export interface SearchParam {
  name: string;
  type: string;
  description: string;
  required: boolean;
  example: string | number | null;
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
  source: "cra-agent" | "market";
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
    const terms = [t, ...(SYNONYMS[t] ?? [])];
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

/** When the question names a pair and the route takes a symbol, the example URL asks for that pair. */
function withAskedSymbol(item: SearchItem, queryTokens: readonly string[]): SearchItem {
  const asked = queryTokens.map((t) => SYMBOL_OF[t]).find(Boolean);
  if (!asked || !item.params.some((p) => p.name === "symbol")) return item;
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
}

export function search(items: readonly SearchItem[], query: string, opts: SearchOptions = {}): SearchResult[] {
  const q = tokens(query);
  const limit = Math.min(50, Math.max(1, opts.limit ?? 10));
  const scored = items
    .filter((i) => (opts.maxPriceUsd === undefined || Number(i.priceUsd) <= opts.maxPriceUsd) && (opts.onlineOnly === false || i.online))
    .map((i) => ({ item: i, score: scoreItem(i, q) }))
    .filter((r) => q.length === 0 || r.score > 0);
  scored.sort((a, b) => b.score - a.score || Number(a.item.priceUsd) - Number(b.item.priceUsd) || (a.item.source === b.item.source ? 0 : a.item.source === "cra-agent" ? -1 : 1));
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

/** Our own catalogue as search items. The route that fails on purpose is proof, not merchandise, and stays out. */
export function ownItems(routes: readonly PaidRoute[], opts: { origin: string; payTo: string; network: string; directPrice: ((price: string) => string) | null }): SearchItem[] {
  const host = new URL(opts.origin).host;
  return routes
    .filter((r) => !r.alwaysFails)
    .map((r) => {
      const params: SearchParam[] = (r.params ?? []).map((p) => ({ name: p.name, type: p.type, description: p.description, required: p.required === true, example: p.example ?? null }));
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
        source: "cra-agent" as const,
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
