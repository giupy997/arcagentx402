/**
 * The marketplace: paid endpoints on Arc, ours and anyone else's.
 *
 * A listing is a URL and nothing more. Everything shown about it is what the URL itself says when
 * it is called without paying: that it answers 402, on Arc, what it costs and who gets paid. A
 * submitter cannot write a word of it, so there is nothing to moderate except the URL, and a
 * listing that stops answering says so on the page. The probe goes through the same guarded fetch
 * as the routes that read a stranger's URL, because that is exactly what this is.
 */
import type { Context, Hono } from "hono";
import type { Logger } from "pino";
import type { Db } from "./db.js";
import { directPriceOf } from "./paid.js";
import { PAID_ROUTES } from "./routes.js";
import { checkUrl, safeFetch, UnsafeUrl } from "./safe-fetch.js";
import { ownItems, pathKey, search, type SearchItem } from "./search.js";

export interface Probe {
  url: string;
  host: string;
  name: string | null;
  description: string | null;
  payTo: string;
  network: string;
  amountUsdc6: string;
  rail: "gateway" | "direct";
  /** Every network the 402 offers, Arc first. */
  networks: string[];
  routes: Array<{ pattern: string; priceUsd: string; description: string | null }> | null;
}

export class NotListable extends Error {}

/** Text that came from someone else's server, made safe to store: one line, bounded, printable. */
export const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const printable = [...v].map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch)).join("");
  const s = printable.replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};

interface Accept {
  scheme?: string;
  network?: string;
  amount?: string;
  maxAmountRequired?: string;
  payTo?: string;
  extra?: { name?: string };
}

/** What a 402 asks for on the given network, from the v2 header or the v1 body. */
export function readChallenge(header: string | undefined, body: string, network: string): { accept: Accept; description: string | null; networks: string[] } {
  let doc: { accepts?: Accept[]; resource?: { description?: string }; description?: string } | null = null;
  for (const source of [header ? Buffer.from(header, "base64").toString("utf8") : null, body]) {
    if (doc || !source) continue;
    try {
      doc = JSON.parse(source);
    } catch {
      doc = null;
    }
  }
  if (!doc || !Array.isArray(doc.accepts)) throw new NotListable("it answers 402 but does not say what it wants to be paid: not an x402 endpoint");
  const accept = doc.accepts.find((a) => a.network === network && a.scheme === "exact");
  if (!accept) throw new NotListable(`it does not take payment on Arc (${network}). Networks it offers: ${[...new Set(doc.accepts.map((a) => a.network))].join(", ") || "none"}`);
  const amount = accept.amount ?? accept.maxAmountRequired;
  if (!accept.payTo || !/^0x[0-9a-fA-F]{40}$/.test(accept.payTo) || !amount || !/^\d{1,12}$/.test(amount)) throw new NotListable("its payment requirements are malformed");
  const networks = [network, ...[...new Set(doc.accepts.map((a) => a.network).filter((n): n is string => typeof n === "string" && n !== network))].slice(0, 8)];
  return { accept: { ...accept, amount }, description: clean(doc.resource?.description ?? doc.description, 240), networks };
}

export async function probe(rawUrl: string, network: string): Promise<Probe> {
  if (rawUrl.length > 300) throw new NotListable("the URL is too long");
  const url = checkUrl(rawUrl);
  if (url.protocol !== "https:") throw new NotListable("buyers need https: list the public https address");
  url.hash = "";
  const res = await safeFetch(url.toString(), { maxBytes: 64_000, timeoutMs: 10_000 }).catch((err: Error) => {
    throw err instanceof UnsafeUrl ? err : new NotListable(`could not reach it: ${err.message}`);
  });
  if (res.status !== 402) throw new NotListable(`it answered ${res.status}, not 402 Payment Required. List the address of a paid route, called without paying`);
  const { accept, description, networks } = readChallenge(res.headers["payment-required"], res.body.toString("utf8"), network);

  // A seller running our proxy, or anyone who cares to, names itself here. Optional: a miss changes nothing.
  // What this one route says about itself in its 402 comes first; the site-wide blurb is the fallback.
  let name: string | null = null;
  let about: string | null = null;
  let routes: Probe["routes"] = null;
  try {
    const wk = await safeFetch(`${url.origin}/.well-known/x402`, { maxBytes: 64_000, timeoutMs: 6000 });
    if (wk.status === 200) {
      const doc = JSON.parse(wk.body.toString("utf8")) as { name?: unknown; description?: unknown; routes?: Array<{ pattern?: unknown; priceUsd?: unknown; description?: unknown }> };
      name = clean(doc.name, 80);
      about = clean(doc.description, 240);
      if (Array.isArray(doc.routes)) {
        routes = doc.routes.slice(0, 40).flatMap((r) => {
          const pattern = clean(r.pattern, 120);
          const priceUsd = clean(r.priceUsd, 16);
          return pattern && priceUsd && /^\d+(\.\d+)?$/.test(priceUsd) ? [{ pattern, priceUsd, description: clean(r.description, 200) }] : [];
        });
      }
    }
  } catch {
    /* no self-description: the 402 is enough */
  }
  return { url: url.toString(), host: url.host, name, description: description ?? about, payTo: accept.payTo!.toLowerCase(), network, amountUsdc6: accept.amount!, rail: accept.extra?.name === "GatewayWalletBatched" ? "gateway" : "direct", networks, routes };
}

interface Row {
  url: string;
  host: string;
  name: string | null;
  description: string | null;
  network?: string;
  pay_to: string;
  amount_usdc6: string;
  rail: string;
  routes: Probe["routes"];
  networks: string[] | null;
  added_at: string;
  checked_at: string;
  ok: boolean;
}

const usd = (units: string): string => (Number(units) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");

export function mountMarket(app: Hono, db: Db, network: string, log: Logger): void {
  const caip2 = network === "mainnet" ? "eip155:5042" : "eip155:5042002";
  const upsert = (p: Probe): Promise<unknown> =>
    db.query(
      `INSERT INTO market_listings (url, host, name, description, pay_to, network, amount_usdc6, rail, routes, networks)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (url) DO UPDATE SET name = $3, description = $4, pay_to = $5, amount_usdc6 = $7, rail = $8, routes = $9, networks = $10, checked_at = now(), ok = true, fails = 0`,
      [p.url, p.host, p.name, p.description, p.payTo, p.network, p.amountUsdc6, p.rail, p.routes ? JSON.stringify(p.routes) : null, p.networks],
    );

  /** One submitter cannot flood the page: a handful of tries an hour per address. */
  const tries = new Map<string, number[]>();
  const allowed = (c: Context): boolean => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    const recent = (tries.get(ip) ?? []).filter((t) => Date.now() - t < 3_600_000);
    if (tries.size > 5000) tries.clear();
    tries.set(ip, [...recent, Date.now()]);
    return recent.length < 10;
  };

  app.post("/v1/market", async (c) => {
    if (!allowed(c)) return c.json({ error: "too many submissions from here, try again in an hour" }, 429);
    const body = (await c.req.json().catch(() => null)) as { url?: unknown } | null;
    if (typeof body?.url !== "string") return c.json({ error: 'send {"url": "https://..."}: the address of a paid route' }, 400);
    try {
      const p = await probe(body.url.trim(), caip2);
      const counts = await db.query<{ total: string; host: string }>("SELECT count(*) AS total, count(*) FILTER (WHERE host = $1) AS host FROM market_listings", [p.host]);
      if (Number(counts.rows[0]!.total) >= 2000) return c.json({ error: "the marketplace is full for now" }, 503);
      if (Number(counts.rows[0]!.host) >= 25) return c.json({ error: "this site already has 25 listings: list the ones that matter" }, 400);
      await upsert(p);
      log.info({ url: p.url, payTo: p.payTo, rail: p.rail }, "market listing added");
      return c.json({ listed: true, listing: { url: p.url, name: p.name, description: p.description, priceUsd: usd(p.amountUsdc6), payTo: p.payTo, rail: p.rail } });
    } catch (err) {
      if (err instanceof NotListable || err instanceof UnsafeUrl) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  /** Listings go stale quietly. A few of the oldest are checked again whenever the page is read. */
  let refreshing = false;
  const refresh = async (): Promise<void> => {
    if (refreshing) return;
    refreshing = true;
    try {
      const due = await db.query<{ url: string }>("SELECT url FROM market_listings WHERE NOT hidden AND checked_at < now() - interval '1 hour' ORDER BY checked_at LIMIT 5");
      for (const { url } of due.rows) {
        try {
          await upsert(await probe(url, caip2));
        } catch {
          await db.query("UPDATE market_listings SET checked_at = now(), fails = fails + 1, ok = (fails + 1 < 3) WHERE url = $1", [url]);
        }
      }
    } catch (err) {
      log.warn({ err }, "market refresh failed");
    } finally {
      refreshing = false;
    }
  };

  app.get("/v1/market", async (c) => {
    const exists = await db.query<{ t: string | null }>("SELECT to_regclass('public.market_listings')::text AS t");
    if (!exists.rows[0]?.t) return c.json({ network: caip2, listings: [] });
    void refresh();
    // A listing that has failed two days of checks is gone, not offline.
    const rows = await db.query<Row>(
      `SELECT url, host, name, description, pay_to, amount_usdc6, rail, routes, networks, extract(epoch FROM added_at)::bigint AS added_at, extract(epoch FROM checked_at)::bigint AS checked_at, ok
       FROM market_listings WHERE NOT hidden AND fails < 48 ORDER BY ok DESC, added_at DESC LIMIT 500`,
    );
    return c.json({
      network: caip2,
      note: "Everything shown about a listing was read from the endpoint itself, called without paying. We do not vouch for what it sells: check the price your wallet or your agent shows before paying.",
      listings: rows.rows.map((r) => ({ url: r.url, host: r.host, name: r.name, description: r.description, priceUsd: usd(r.amount_usdc6), payTo: r.pay_to, rail: r.rail, networks: r.networks ?? [r.network ?? caip2], routes: r.routes, online: r.ok, addedAt: Number(r.added_at), checkedAt: Number(r.checked_at) })),
    });
  });

  /** The market listings as search items, refreshed at most every half minute. */
  let listed: { at: number; items: SearchItem[] } = { at: 0, items: [] };
  const listedItems = async (): Promise<SearchItem[]> => {
    if (Date.now() - listed.at < 30_000) return listed.items;
    const exists = await db.query<{ t: string | null }>("SELECT to_regclass('public.market_listings')::text AS t");
    if (!exists.rows[0]?.t) return [];
    const rows = await db.query<Row>(`SELECT url, host, name, description, pay_to, amount_usdc6, rail, routes, networks, ok FROM market_listings WHERE NOT hidden AND fails < 48 LIMIT 2000`);
    const items: SearchItem[] = rows.rows.map((r) => ({
      url: r.url,
      method: "GET",
      priceUsd: usd(r.amount_usdc6),
      name: r.name ?? r.host,
      label: null,
      description: r.description,
      params: [],
      payTo: r.pay_to,
      host: r.host,
      network: caip2,
      rail: r.rail === "gateway" ? "gateway" : "direct",
      direct: null,
      source: "market",
      online: r.ok,
      keywords: `${new URL(r.url).pathname.replace(/[/_-]+/g, " ")} ${(r.routes ?? []).map((x) => `${x.pattern} ${x.description ?? ""}`).join(" ")}`,
    }));
    listed = { at: Date.now(), items };
    return items;
  };

  /**
   * What an agent can buy on Arc, for a few words of what it needs. Free: finding something to buy
   * should not cost anything. Our own routes come with their parameters; market listings with what
   * their 402 and /.well-known/x402 said. Everything here is payable on Arc by any x402 client.
   */
  app.get("/v1/market/search", async (c) => {
    const q = (c.req.query("q") ?? "").slice(0, 200);
    const maxRaw = c.req.query("maxPriceUsd");
    if (maxRaw !== undefined && !/^\d{1,6}(\.\d{1,6})?$/.test(maxRaw)) return c.json({ error: "maxPriceUsd must be an amount in dollars, like 0.01" }, 400);
    const limit = Number(c.req.query("limit") ?? 10);
    const origin = new URL(c.req.url).origin;
    const seller = process.env.SELLER_ADDRESS;
    const own = seller ? ownItems(PAID_ROUTES, { origin, payTo: seller, network: caip2, directPrice: process.env.DIRECT_FACILITATOR_URL ? directPriceOf : null }) : [];
    // A market listing of one of our routes adds nothing to the route itself, which carries its parameters.
    const ownKeys = new Set(own.flatMap((i) => [pathKey(i.url), ...(i.direct ? [pathKey(i.direct.url)] : [])]));
    const market = (await listedItems()).filter((i) => !ownKeys.has(pathKey(i.url)));
    const results = search([...own, ...market], q, { ...(maxRaw === undefined ? {} : { maxPriceUsd: Number(maxRaw) }), limit: Number.isFinite(limit) ? limit : 10 });
    return c.json({
      query: q,
      network: caip2,
      count: results.length,
      searched: { ownRoutes: own.length, marketListings: market.length },
      results,
      note: "Every result answers 402 on Arc. Prices are what the seller asked when last checked: quote the URL before paying. The example values in each URL are examples; change them to what you need, following params.",
    });
  });
}
