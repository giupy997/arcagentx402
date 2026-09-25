/**
 * The bazaar: everything an agent can buy on Arc, by seller and by kind, for people to browse and for
 * agents to search. It is one view over the catalogue search already uses: our routes, the CRA market
 * and Circle's x402 catalogue.
 *
 * Logos are read from each seller's own site by this server, kept, and served from here, so a visitor's
 * browser asks no third party. Only sellers in the catalogue are fetched, only raster images are served
 * (an SVG can carry script), and a seller without a usable icon gets none rather than a guess.
 */
import type { Hono } from "hono";
import type { Logger } from "pino";
import type { Catalogue } from "./market.js";
import { safeFetch, type Fetched, type SafeFetchOptions } from "./safe-fetch.js";
import type { SearchItem } from "./search.js";

export interface BazaarSeller {
  name: string;
  source: SearchItem["source"];
  site: string | null;
  /** Path of the seller's logo on this API; null for ours, which the site already has. */
  logo: string | null;
  /** One sentence for the whole seller, when most of its endpoints share it. */
  description: string | null;
  categories: string[];
  endpoints: number;
  priceFrom: string;
  priceTo: string;
  /** The API families it sells, read from its paths: agentmail, apollo, polymarket… The ten biggest; empty for a single-product seller. */
  families: string[];
  /** How many families in all, when there is more than one. */
  familyCount: number;
  /** gateway: paid through Circle Gateway. direct: a signed transfer a facilitator settles. both: some of each. */
  rail: "gateway" | "direct" | "both";
  /** Every network at least one of its endpoints takes payment on, Arc first, then by how many. */
  networks: string[];
  /** The networks where at least one of its endpoints takes a plain x402 payment from any client. */
  plainNetworks: string[];
}

export interface BazaarOverview {
  network: string;
  counts: { endpoints: number; sellers: number; categories: number };
  categories: Array<{ name: string; endpoints: number; sellers: number }>;
  /** How much of the bazaar each network can pay for: an agent on Base, say, sees what it can buy. Arc, Base and Solana first. */
  networks: Array<{ id: string; name: string; endpoints: number; sellers: number; plain: number; logo: string | null }>;
  sellers: BazaarSeller[];
  circleReadAt: number | null;
  note: string;
}

const OURS_DESCRIPTION = "Live Arc network data, executed prices from real swaps, and web and package tools.";

/** Network names for the ones a person would recognise; anything else keeps its CAIP-2 id. */
export const NETWORK_NAMES: Record<string, string> = {
  "eip155:5042": "Arc",
  "eip155:5042002": "Arc testnet",
  "eip155:8453": "Base",
  "eip155:1": "Ethereum",
  "eip155:137": "Polygon",
  "eip155:42161": "Arbitrum",
  "eip155:10": "Optimism",
  "eip155:43114": "Avalanche",
  "eip155:130": "Unichain",
  "eip155:59144": "Linea",
  "eip155:480": "World Chain",
  "eip155:1329": "Sei",
  "eip155:146": "Sonic",
  "eip155:999": "HyperEVM",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "Solana",
};
/** Each network's own site, where its logo is read from, the same way a seller's is. */
/** Free public APIs the thinking agent calls (cra-agent.tech/think shows their logo next to what it paid for). */
export const FREE_TOOL_SITES: readonly string[] = ["https://dexscreener.com"];

export const NETWORK_SITES: Record<string, string> = {
  "eip155:5042": "https://www.arc.network",
  "eip155:5042002": "https://www.arc.network",
  "eip155:8453": "https://www.base.org",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "https://solana.com",
  "eip155:1": "https://ethereum.org",
  "eip155:137": "https://polygon.technology",
  "eip155:42161": "https://arbitrum.io",
  "eip155:10": "https://www.optimism.io",
  // avax.network serves no raster icon; its builders' site does.
  "eip155:43114": "https://build.avax.network",
  "eip155:130": "https://www.unichain.org",
  "eip155:59144": "https://linea.build",
  "eip155:480": "https://world.org",
  "eip155:1329": "https://www.sei.io",
  "eip155:146": "https://www.soniclabs.com",
  "eip155:999": "https://hyperliquid.xyz",
};
/** The networks CRA AGENT's own routes take, shown first wherever networks are listed. */
const LEAD = ["eip155:5042", "eip155:5042002", "eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"];
const lead = (id: string): number => (LEAD.includes(id) ? LEAD.indexOf(id) : LEAD.length);
const logoPath = (site: string): string => `/v1/bazaar/logo?site=${encodeURIComponent(site)}`;

/** Path segments that say how an API is served, not what it sells. */
const PLUMBING = new Set(["api", "apis", "v0", "v1", "v2", "v3", "paid", "direct", "standard", "evm", "x402", "public", "rest"]);

/** The family of an endpoint: the first path segment that names what it sells. */
export function familyOf(url: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  for (const raw of path.split("/").filter(Boolean)) {
    const seg = raw.toLowerCase();
    if (PLUMBING.has(seg) || /^\{.*\}$/.test(seg) || /^\d+$/.test(seg)) continue;
    return /^[a-z][a-z0-9-]{1,30}$/.test(seg) ? seg : null;
  }
  return null;
}

function tally<T>(list: readonly SearchItem[], pick: (i: SearchItem) => T | null | undefined): Map<T, number> {
  const m = new Map<T, number>();
  for (const i of list) {
    const v = pick(i);
    if (v !== null && v !== undefined) m.set(v, (m.get(v) ?? 0) + 1);
  }
  return m;
}
const topKeys = <T>(m: Map<T, number>, n: number): T[] => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);

export function bazaarOverview(cat: Catalogue, network: string): BazaarOverview {
  const items = [...cat.own, ...cat.market, ...cat.circle];
  const groups = new Map<string, SearchItem[]>();
  for (const i of items) groups.set(`${i.source}|${i.name}`, [...(groups.get(`${i.source}|${i.name}`) ?? []), i]);
  const sellers: BazaarSeller[] = [...groups.values()].map((list) => {
    const first = list[0]!;
    const [description, said] = [...tally(list, (i) => i.description)].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    const families = tally(list, (i) => familyOf(i.url));
    const byPrice = [...list].sort((a, b) => Number(a.priceUsd) - Number(b.priceUsd));
    const rails = new Set(list.map((i) => i.rail));
    const networks = new Map<string, number>();
    for (const i of list) for (const n of new Set(i.networks)) networks.set(n, (networks.get(n) ?? 0) + 1);
    const site = topKeys(tally(list, (i) => i.site), 1)[0] ?? null;
    const ours = first.source === "cra-agent";
    // A sentence about one of a proxy's APIs is not about the proxy: across several families it must span more than one.
    const spans = new Set(list.filter((i) => i.description === description).map((i) => familyOf(i.url))).size;
    const shared = description !== null && said >= list.length * 0.6 && (families.size <= 1 || spans > 1);
    return {
      name: first.name,
      source: first.source,
      site,
      logo: ours || !site ? null : logoPath(site),
      // A proxy of many APIs has no one sentence for itself; its families say more.
      description: ours ? OURS_DESCRIPTION : shared ? description : null,
      categories: topKeys(tally(list, (i) => i.category), 3),
      endpoints: list.length,
      priceFrom: byPrice[0]!.priceUsd,
      priceTo: byPrice[byPrice.length - 1]!.priceUsd,
      families: families.size > 1 ? topKeys(families, 10) : [],
      familyCount: families.size > 1 ? families.size : 0,
      rail: rails.size > 1 ? "both" : first.rail,
      networks: [...networks].sort((a, b) => lead(a[0]) - lead(b[0]) || b[1] - a[1]).map(([n]) => n),
      plainNetworks: [...new Set(list.flatMap((i) => i.plainNetworks))].sort((a, b) => lead(a) - lead(b)),
    };
  });
  // Ours first, it is our bazaar and says so; then by how much each sells.
  sellers.sort((a, b) => Number(b.source === "cra-agent") - Number(a.source === "cra-agent") || b.endpoints - a.endpoints || a.name.localeCompare(b.name));
  const categories = [...tally(items, (i) => i.category)].map(([name, endpoints]) => ({ name, endpoints, sellers: new Set(items.filter((i) => i.category === name).map((i) => `${i.source}|${i.name}`)).size }));
  categories.sort((a, b) => b.endpoints - a.endpoints);
  const perNetwork = new Map<string, { endpoints: number; sellers: Set<string>; plain: number }>();
  for (const i of items) {
    for (const n of new Set(i.networks)) {
      const row = perNetwork.get(n) ?? { endpoints: 0, sellers: new Set<string>(), plain: 0 };
      row.endpoints++;
      if (i.plainNetworks.includes(n)) row.plain++;
      row.sellers.add(`${i.source}|${i.name}`);
      perNetwork.set(n, row);
    }
  }
  const networks = [...perNetwork]
    .map(([id, r]) => ({ id, name: NETWORK_NAMES[id] ?? id, endpoints: r.endpoints, sellers: r.sellers.size, plain: r.plain, logo: NETWORK_SITES[id] ? logoPath(NETWORK_SITES[id]) : null }))
    .sort((a, b) => lead(a.id) - lead(b.id) || b.endpoints - a.endpoints);
  return {
    network,
    counts: { endpoints: items.length, sellers: sellers.length, categories: categories.length },
    categories,
    networks,
    sellers,
    circleReadAt: cat.circleReadAt,
    note: "Our routes, the CRA market (each listing called every hour to check it answers 402 on Arc) and Circle's x402 catalogue (read every hour, listed by Circle, not checked by us). What a seller says it sells is its own description.",
  };
}

/** Raster formats a logo may be, by their first bytes. SVG is not among them: it can carry script. */
const RASTER: ReadonlyArray<{ type: string; test: (b: Buffer) => boolean }> = [
  { type: "image/png", test: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 },
  { type: "image/jpeg", test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: "image/gif", test: (b) => b.subarray(0, 4).toString("latin1") === "GIF8" },
  { type: "image/webp", test: (b) => b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
  { type: "image/x-icon", test: (b) => b.length > 6 && b.readUInt32BE(0) === 0x00000100 },
];

/** What image a file is, from its bytes rather than what its server says. */
export function sniffImage(b: Buffer): string | null {
  return RASTER.find((r) => r.test(b))?.type ?? null;
}

/** A page's icons, best first: apple-touch-icon, then the largest declared, then the usual fallbacks. */
export function iconCandidates(html: string, base: string): string[] {
  const found: Array<{ href: string; score: number }> = [];
  for (const tag of (html.match(/<link\b[^>]*>/gi) ?? []).slice(0, 300)) {
    const attr = (name: string): string | undefined => {
      const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
      return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
    };
    const rel = (attr("rel") ?? "").toLowerCase();
    const href = attr("href");
    if (!href || !/(^|\s)(icon|apple-touch-icon|apple-touch-icon-precomposed)(\s|$)/.test(rel)) continue;
    if ((attr("type") ?? "").toLowerCase().includes("svg") || /\.svg(\?|#|$)/i.test(href)) continue;
    const size = Math.max(0, ...(attr("sizes") ?? "").split(/\s+/).map((s) => Number(s.toLowerCase().split("x")[0]) || 0));
    try {
      found.push({ href: new URL(href, base).toString(), score: (rel.includes("apple-touch-icon") ? 1000 : 0) + size });
    } catch {
      /* not a URL */
    }
  }
  const origin = new URL(base).origin;
  const ranked = found.sort((a, b) => b.score - a.score).map((f) => f.href);
  return [...new Set([...ranked, `${origin}/apple-touch-icon.png`, `${origin}/favicon.ico`])].filter((u) => u.startsWith("https://")).slice(0, 6);
}

export interface Logo {
  type: string;
  body: Buffer;
}

/** Reads and keeps sellers' logos: a day when found, six hours when not, one read at a time per site. */
export function logoFetcher(opts: { fetch?: (url: string, o: SafeFetchOptions) => Promise<Fetched>; now?: () => number } = {}): (site: string) => Promise<Logo | null> {
  const get = opts.fetch ?? safeFetch;
  const now = opts.now ?? Date.now;
  const kept = new Map<string, { at: number; logo: Logo | null }>();
  const reading = new Map<string, Promise<Logo | null>>();
  const read = async (site: string): Promise<Logo | null> => {
    const page = await get(site, { maxBytes: 400_000, timeoutMs: 6000 }).catch(() => null);
    const html = page && page.status === 200 ? page.body.toString("utf8") : "";
    for (const url of iconCandidates(html, page?.finalUrl ?? site)) {
      const r = await get(url, { maxBytes: 250_000, timeoutMs: 6000 }).catch(() => null);
      if (!r || r.status !== 200 || r.truncated || r.body.length < 64) continue;
      const type = sniffImage(r.body);
      if (type) return { type, body: r.body };
    }
    return null;
  };
  return async (site) => {
    const hit = kept.get(site);
    if (hit && now() - hit.at < (hit.logo ? 86_400_000 : 21_600_000)) return hit.logo;
    let pending = reading.get(site);
    if (!pending) {
      pending = read(site).finally(() => reading.delete(site));
      reading.set(site, pending);
    }
    const logo = await pending;
    if (kept.size > 500) kept.clear();
    kept.set(site, { at: now(), logo });
    return logo;
  };
}

export function mountBazaar(app: Hono, deps: { catalogue: (origin: string) => Promise<Catalogue>; network: string; log: Logger }): void {
  const caip2 = deps.network === "mainnet" ? "eip155:5042" : "eip155:5042002";
  // Kept per origin: our own routes carry the address they were asked on, and a check from the server
  // itself (localhost) must not stand in for what the public address shows.
  const latest = new Map<string, { at: number; body: BazaarOverview; sites: Set<string> }>();
  const overview = async (origin: string): Promise<{ body: BazaarOverview; sites: Set<string> }> => {
    const hit = latest.get(origin);
    if (hit && Date.now() - hit.at < 60_000) return hit;
    const body = bazaarOverview(await deps.catalogue(origin), caip2);
    const fresh = { at: Date.now(), body, sites: new Set([...body.sellers.flatMap((s) => (s.site ? [s.site] : [])), ...Object.values(NETWORK_SITES), ...FREE_TOOL_SITES]) };
    if (latest.size > 8) latest.clear();
    latest.set(origin, fresh);
    return fresh;
  };

  /** The whole bazaar in one answer: sellers, categories, counts. Free, like search. */
  app.get("/v1/bazaar", async (c) => c.json((await overview(new URL(c.req.url).origin)).body));

  const logo = logoFetcher();
  app.get("/v1/bazaar/logo", async (c) => {
    const site = c.req.query("site") ?? "";
    // Only the sites of sellers in the bazaar: this is not an image proxy for the internet.
    const { sites } = await overview(new URL(c.req.url).origin);
    if (!sites.has(site)) return c.json({ error: "not a seller in the bazaar" }, 404);
    const found = await logo(site).catch((err: Error) => {
      deps.log.warn({ site, err: err.message }, "logo not read");
      return null;
    });
    if (!found) return c.body(null, 404, { "cache-control": "public, max-age=21600" });
    return c.body(new Uint8Array(found.body), 200, { "content-type": found.type, "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'" });
  });
}
