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
 */
import { Hono } from "hono";
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
  readonly fetch?: typeof fetch;
}

const AMOUNT = /^\$?\d{1,6}(\.\d{1,6})?$/;
/** Headers that belong to one hop, or to the payment, and must not travel upstream. */
const NOT_FORWARDED = new Set(["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authorization", "proxy-authenticate", "content-length", "payment-signature", "x-payment", "accept-encoding"]);
/** Headers of the upstream response that describe its transport, not its content. */
const NOT_RETURNED = new Set(["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length"]);

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
    ...(opts.onSettlement ? { onSettlement: opts.onSettlement } : {}),
    ...(opts.facilitatorUrl ? { settlement: "direct" as const, facilitatorUrl: opts.facilitatorUrl } : {}),
  });
  for (const r of routes) seller.route(r.pattern, r.price, { description: r.description ?? opts.description ?? `${opts.name ?? "API"}: ${r.pattern}`, maxTimeoutSeconds: 120 });

  const app = new Hono();
  /** What is for sale here, free to read: directories and agents look for it before paying. */
  app.get("/.well-known/x402", (c) =>
    c.json({
      x402Version: 2,
      name: opts.name ?? null,
      description: opts.description ?? null,
      network: seller.network,
      payTo: seller.sellerAddress,
      settlement: opts.facilitatorUrl ? "direct" : "circle-gateway",
      routes: routes.map((r) => ({ pattern: r.pattern, priceUsd: r.price.replace("$", ""), description: r.description ?? null })),
      free: [...(opts.free ?? [])],
      poweredBy: "https://cra-agent.tech",
    }),
  );

  const paywall = seller.middleware();
  app.use("*", async (c, next) => {
    if (c.req.path === "/.well-known/x402") return next();
    if (freeMatchers.some((m) => m(c.req.method, c.req.path))) return next();
    return paywall(c, next);
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
