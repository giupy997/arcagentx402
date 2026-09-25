/**
 * A paywall in front of an API that already exists.
 *
 * The seller changes nothing in their own code: this process stands in front of it, answers 402
 * with a price to a caller who has not paid, and passes a paid request through untouched. The
 * payment is settled only after the API behind it has answered without an error, so a request
 * the upstream fails is never charged.
 *
 * What is ours here is the forwarding and the catalogue. Pricing, verification and settlement are
 * the same seller the rest of this package exposes.
 *
 * With a Lightning node the same routes are also for sale in sats: the 402 then carries an `exact` offer on
 * `lnbtc` next to the others, with a fresh invoice from the seller's node bound to the request. That scheme is
 * paid up front: the proof is checked and claimed before the call goes upstream, and the sats stay with the
 * seller even if the API behind then fails.
 */
import type { Context } from "hono";
import { Hono } from "hono";
import { lnbtcPaywall, paymentNetwork, type BtcUsd, type LnbtcFacilitatorClient, type ReceiverAdapter, type ReplayStore } from "@cra-agent/lightning";
import { createSeller, type SellerConfig, type SettlementEvent } from "./index.js";

export interface PricedPath {
  /** x402 route syntax: "/*", "GET /v1/forecast", "POST /v1/render/*". */
  readonly pattern: string;
  /** Dollars, like "0.002" or "$0.002". */
  readonly price: string;
  readonly description?: string;
}

export interface ProxyOptions {
  /** The API being sold, e.g. https://api.example.com. A path on it is kept as a prefix. */
  readonly target: string;
  readonly payTo: string;
  /** A Solana address: the same routes are then also for sale to buyers on Solana, paid there. */
  readonly payToSolana?: string;
  readonly network: SellerConfig["network"];
  readonly routes: readonly PricedPath[];
  /** Paths served without payment, in the same syntax. Health checks, docs. */
  readonly free?: readonly string[];
  readonly name?: string;
  readonly description?: string;
  /** Added to every request sent upstream, e.g. the key the upstream API wants. Never sent back to buyers. */
  readonly upstreamHeaders?: Readonly<Record<string, string>>;
  /** Milliseconds to wait for the upstream. Default 30 s. */
  readonly timeoutMs?: number;
  readonly onSettlement?: (event: SettlementEvent) => void;
  /** Settle directly through this facilitator instead of Circle Gateway. */
  readonly facilitatorUrl?: string;
  /** Also sell for bitcoin over Lightning, paid to the seller's own node. */
  readonly lightning?: LightningSale;
  readonly fetch?: typeof fetch;
}

export interface LightningSale {
  /** The seller's node, receiving: nwcReceiver with a receive-only connection, or any ReceiverAdapter. */
  readonly receiver: ReceiverAdapter;
  /** LNBTC_MAINNET or LNBTC_TESTNET, as the node is. */
  readonly network: string;
  readonly rate: () => Promise<BtcUsd>;
  /** Where settled proofs are remembered, here. It must survive restarts: FileReplayStore, without a database. */
  readonly replay?: ReplayStore;
  /** Or a facilitator that checks and remembers them. One of the two, and the same one every time for a node. */
  readonly facilitator?: LnbtcFacilitatorClient;
  /** The least an invoice asks, in millisatoshis. Default 1,000: one sat. */
  readonly minMsat?: bigint;
  /** How long a 402 waits for the node's invoice before it goes out without one. Default 5 s. */
  readonly offerTimeoutMs?: number;
  readonly onSettled?: (e: LightningSettlement) => void;
}

export interface LightningSettlement {
  readonly resource: string;
  readonly paymentHash: string;
  readonly amountMsat: string;
  readonly priceUsd: string;
  /** What the API behind answered. The sats were taken before it ran. */
  readonly status: number;
}

const AMOUNT = /^\$?\d{1,6}(\.\d{1,6})?$/;
/** Headers that belong to one hop, or to the payment, and must not travel upstream. */
const NOT_FORWARDED = new Set(["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authorization", "proxy-authenticate", "content-length", "payment-signature", "x-payment", "accept-encoding"]);
/** Headers of the upstream response that describe its transport, not its content. */
const NOT_RETURNED = new Set(["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length"]);
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

export function normalisePrice(raw: string): string {
  const v = raw.trim();
  if (!AMOUNT.test(v) || Number(v.replace("$", "")) <= 0) throw new Error(`price "${raw}" is not an amount in dollars, like 0.002`);
  return v.startsWith("$") ? v : `$${v}`;
}

/** "GET /a/*=0.002" or "/a=0.01", as the command line takes it. */
export function parseRouteFlag(flag: string): PricedPath {
  const eq = flag.lastIndexOf("=");
  if (eq < 1) throw new Error(`--route "${flag}": expected "<pattern>=<price>", like "GET /v1/forecast=0.002"`);
  const pattern = flag.slice(0, eq).trim();
  if (!/^([A-Za-z]+\s+)?\/\S*$/.test(pattern)) throw new Error(`--route "${flag}": the pattern must be a path, optionally after a method`);
  return { pattern, price: normalisePrice(flag.slice(eq + 1)) };
}

function matcher(pattern: string): (method: string, path: string) => boolean {
  const [verb, path] = pattern.includes(" ") ? (pattern.split(/\s+/) as [string, string]) : ["*", pattern];
  const wild = path.endsWith("/*");
  const body = (wild ? path.slice(0, -2) : path).replace(/[$()+.?^{|}\\]/g, "\\$&").replace(/\*/g, ".*?").replace(/\//g, "\\/");
  const regex = new RegExp(`^${body}${wild ? "(?:/.*)?" : ""}$`, "i");
  return (method, p) => (verb === "*" || verb.toUpperCase() === method.toUpperCase()) && regex.test(p);
}

/** The upstream URL for a request path: the target's own path stays in front. */
export function upstreamUrl(target: string, pathAndQuery: string): string {
  const base = new URL(target);
  const prefix = base.pathname.replace(/\/+$/, "");
  return `${base.origin}${prefix}${pathAndQuery.startsWith("/") ? "" : "/"}${pathAndQuery}`;
}

export function createProxyApp(opts: ProxyOptions): Hono {
  if (!/^https?:\/\//i.test(opts.target)) throw new Error("target must be an http(s) URL");
  if (opts.routes.length === 0) throw new Error("nothing to sell: give a price");
  const doFetch = opts.fetch ?? fetch;
  const routes = opts.routes.map((r) => ({ ...r, price: normalisePrice(r.price) }));
  const freeMatchers = (opts.free ?? []).map(matcher);

  const seller = createSeller({
    sellerAddress: opts.payTo,
    network: opts.network,
    ...(opts.name ? { serviceName: opts.name } : {}),
    ...(opts.payToSolana ? { solana: { payTo: opts.payToSolana } } : {}),
    ...(opts.onSettlement ? { onSettlement: opts.onSettlement } : {}),
    ...(opts.facilitatorUrl ? { settlement: "direct" as const, facilitatorUrl: opts.facilitatorUrl } : {}),
  });
  for (const r of routes) seller.route(r.pattern, r.price, { description: r.description ?? opts.description ?? `${opts.name ?? "API"}: ${r.pattern}`, maxTimeoutSeconds: 120 });

  const ln = opts.lightning;
  const sats = ln ? lnbtcPaywall({ receiver: async () => ln.receiver, network: ln.network, ...(ln.facilitator ? { facilitator: ln.facilitator } : {}), ...(ln.replay ? { replay: ln.replay } : {}), rate: ln.rate, ...(ln.minMsat ? { minMsat: ln.minMsat } : {}) }) : null;
  // The first pattern that matches sets the price, as it does for the other rails.
  const priced = routes.map((r) => ({ priceUsd: r.price.replace("$", ""), matches: matcher(r.pattern) }));

  const app = new Hono();
  /** What is for sale here, free to read: directories and agents look for it before paying. */
  app.get("/.well-known/x402", (c) =>
    c.json({
      x402Version: 2,
      name: opts.name ?? null,
      description: opts.description ?? null,
      network: seller.network,
      payTo: seller.sellerAddress,
      ...(opts.payToSolana ? { solana: { payTo: opts.payToSolana } } : {}),
      ...(ln ? { lightning: { network: ln.network, payTo: ln.receiver.pubkey, scheme: "exact", asset: "BTC", pricing: "each route's dollar price in millisatoshis at the BTC/USD rate when the 402 is made, at least 1 sat", settledBy: ln.facilitator ? ln.facilitator.url : "this server" } } : {}),
      networks: [seller.network, ...(opts.payToSolana ? [opts.network === "arc" ? "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" : "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"] : []), ...(ln ? [ln.network] : [])],
      settlement: opts.facilitatorUrl ? "direct" : "circle-gateway",
      routes: routes.map((r) => ({ pattern: r.pattern, priceUsd: r.price.replace("$", ""), description: r.description ?? null })),
      free: [...(opts.free ?? [])],
      poweredBy: "https://cra-agent.tech",
    }),
  );

  /** The request as the buyer made it: an invoice is bound to its method, URL and body. */
  const saleOf = async (c: Context, priceUsd: string) => ({
    method: c.req.method,
    url: c.req.raw.url,
    body: ["GET", "HEAD"].includes(c.req.method) ? null : new Uint8Array(await c.req.arrayBuffer()),
    header: (n: string) => c.req.header(n) ?? null,
    priceUsd,
  });

  const paywall = seller.middleware();
  app.use("*", async (c, next) => {
    if (c.req.path === "/.well-known/x402") return next();
    if (freeMatchers.some((m) => m(c.req.method, c.req.path))) return next();
    const priceUsd = sats ? priced.find((r) => r.matches(c.req.method, c.req.path))?.priceUsd : undefined;
    if (!sats || !ln || !priceUsd) return paywall(c, next);
    const payment = c.req.header("payment-signature") ?? c.req.header("x-payment");

    if (payment && paymentNetwork(payment)?.startsWith("lnbtc:")) {
      const settled = await sats.settle(await saleOf(c, priceUsd), payment);
      if (!settled.ok && settled.status === 503) return c.json({ error: `the payment could not be checked right now (${settled.error}); nothing was claimed, send the same proof again shortly` }, 503);
      if (!settled.ok) {
        const refused = { x402Version: 2, error: settled.error, resource: { url: c.req.raw.url }, accepts: [] };
        return c.json(refused, 402, { "PAYMENT-REQUIRED": b64(refused) });
      }
      await next();
      // The upstream's own response comes back as it is: the receipt goes on it afterwards.
      const served = new Response(c.res.body, c.res);
      served.headers.set("PAYMENT-RESPONSE", b64(settled.settlement));
      c.res = undefined;
      c.res = served;
      ln.onSettled?.({ resource: c.req.raw.url, paymentHash: settled.settlement.transaction, amountMsat: settled.amountMsat, priceUsd, status: c.res.status });
      return;
    }

    const res = (await paywall(c, next)) ?? c.res;
    // An offer in sats goes on a 402 for an API caller, next to the other rails. A browser gets the paywall page.
    const required = !payment && res.status === 402 && !(res.headers.get("content-type") ?? "").includes("text/html") ? res.headers.get("PAYMENT-REQUIRED") : null;
    if (!required) return res;
    const client = (c.req.header("x-forwarded-for") ?? "").split(",")[0]!.trim() || "direct";
    const sale = await saleOf(c, priceUsd);
    const offer = await Promise.race([sats.offer(sale, client), new Promise<null>((r) => setTimeout(() => r(null), ln.offerTimeoutMs ?? 5_000).unref?.())]);
    if (!offer?.ok) return res; // no rate, too many invoices, or the node is slow: the other rails are still on offer
    let doc: { accepts?: unknown[] } | null = null;
    try {
      doc = JSON.parse(Buffer.from(required, "base64").toString("utf8")) as { accepts?: unknown[] };
    } catch {
      return res;
    }
    if (!Array.isArray(doc?.accepts)) return res;
    const headers = new Headers(res.headers);
    headers.set("PAYMENT-REQUIRED", b64({ ...doc, accepts: [...doc.accepts, offer.requirements] }));
    return new Response(res.body, { status: res.status, headers });
  });

  app.all("*", async (c) => {
    const url = new URL(c.req.url);
    const headers = new Headers();
    c.req.raw.headers.forEach((v, k) => {
      if (!NOT_FORWARDED.has(k.toLowerCase())) headers.set(k, v);
    });
    for (const [k, v] of Object.entries(opts.upstreamHeaders ?? {})) headers.set(k, v);
    const hasBody = !["GET", "HEAD"].includes(c.req.method);
    let res: Response;
    try {
      res = await doFetch(upstreamUrl(opts.target, `${url.pathname}${url.search}`), {
        method: c.req.method,
        headers,
        ...(hasBody ? { body: await c.req.arrayBuffer() } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
    } catch (err) {
      // 502 keeps the payment unsettled: the buyer asked for an answer and there is none.
      return c.json({ error: `the API behind this paywall did not answer: ${(err as Error).message}`, charged: false }, 502);
    }
    const out = new Headers();
    res.headers.forEach((v, k) => {
      if (!NOT_RETURNED.has(k.toLowerCase())) out.set(k, v);
    });
    return new Response(res.body, { status: res.status, headers: out });
  });
  return app;
}
