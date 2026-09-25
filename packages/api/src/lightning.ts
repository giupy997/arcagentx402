/**
 * Our paid routes, paid in bitcoin over Lightning: x402 `exact` on `lnbtc` (x402's scheme_exact_lnbtc.md).
 *
 * /v1/lightning/<route> is /v1/paid/<route> with a 402 that carries a fresh invoice from our node, bound to
 * the request by its signed description hash. A paid retry is settled before it is served, as the scheme
 * asks: the proof is checked here, against the request that will run, and its payment hash is claimed once
 * in Postgres. A seller that fails after that cannot give the sats back; Lightning has no refund.
 *
 * It lives beside /v1/paid rather than in its 402 because that middleware verifies, serves, then settles,
 * and because every 402 there would wait on our node for an invoice most buyers would never pay.
 */
import type { Context, MiddlewareHandler } from "hono";
import { lnbtcPaywall, type BtcUsd, type ReceiverAdapter, type ReplayStore } from "@cra-agent/lightning";

export interface LightningRoute {
  /** Path under /v1/lightning. */
  readonly path: string;
  /** Dollars, as a decimal string. */
  readonly priceUsd: string;
  readonly description: string;
}

export interface LightningSettled {
  readonly route: string;
  readonly paymentHash: string;
  readonly amountMsat: string;
  readonly priceUsd: string;
  readonly status: number;
}

export interface LightningOptions {
  readonly receiver: () => Promise<ReceiverAdapter>;
  readonly network: string;
  /** Where buyers reach us, e.g. https://api.cra-agent.tech: the URL an invoice is bound to. */
  readonly publicOrigin: string;
  readonly routes: readonly LightningRoute[];
  readonly replay: ReplayStore;
  readonly rate: () => Promise<BtcUsd>;
  /** The least an invoice asks, in millisatoshis. */
  readonly minMsat?: bigint;
  readonly maxTimeoutSeconds?: number;
  /** A paid retry keeps the amount its invoice named when that is within this share of today's price. */
  readonly tolerance?: number;
  /** New invoices per client address per minute, and for everyone per minute. */
  readonly limits?: { readonly perClient: number; readonly total: number };
  readonly onSettled?: (e: LightningSettled) => void | Promise<void>;
  readonly now?: () => number;
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

/** The request target as the client sent it, escapes and query order kept, after our public origin. */
function publicUrl(c: Context, origin: string): string {
  const raw = c.req.raw.url;
  const start = raw.indexOf("/", raw.indexOf("//") + 2);
  return `${origin.replace(/\/+$/, "")}${start >= 0 ? raw.slice(start) : "/"}`;
}

const UNAVAILABLE = {
  no_rate: "no reliable BTC/USD rate right now, so no price in sats; the /v1/paid rails still work",
  node_unavailable: "our Lightning node did not issue an invoice; the /v1/paid rails still work",
} as const;

export function lightningMiddleware(o: LightningOptions): MiddlewareHandler {
  const paywall = lnbtcPaywall(o);
  const byPath = new Map(o.routes.map((r) => [r.path, r]));

  return async (c, next) => {
    const route = c.req.method === "GET" ? byPath.get(c.req.path) : undefined;
    if (!route) return next();
    const url = publicUrl(c, o.publicOrigin);
    const sale = { method: c.req.method, url, body: null, header: (n: string) => c.req.header(n) ?? null, priceUsd: route.priceUsd };
    const resource = { url, description: route.description, mimeType: "application/json" };
    const payment = c.req.header("payment-signature") ?? c.req.header("x-payment");

    if (!payment) {
      const client = (c.req.header("x-forwarded-for") ?? "").split(",")[0]!.trim() || "direct";
      const offer = await paywall.offer(sale, client);
      if (!offer.ok && offer.status === 429) return c.json({ error: offer.error, detail: "too many new invoices from this address; try again in a minute" }, 429);
      if (!offer.ok) return c.json({ error: UNAVAILABLE[offer.error as keyof typeof UNAVAILABLE] }, 503);
      const required = { x402Version: 2, error: "Payment required", resource, accepts: [offer.requirements] };
      return c.json({ ...required, priceUsd: route.priceUsd, btcUsd: offer.btcUsd }, 402, { "PAYMENT-REQUIRED": b64(required) });
    }

    const settled = await paywall.settle(sale, payment);
    if (!settled.ok && settled.status === 503) return c.json({ error: settled.error === "node_unavailable" ? "our Lightning node is not reachable right now" : "the payment could not be recorded right now; send the same proof again in a minute" }, 503);
    if (!settled.ok) {
      const refused = { x402Version: 2, error: settled.error, resource, accepts: [] };
      return c.json(refused, 402, { "PAYMENT-REQUIRED": b64(refused) });
    }
    c.header("PAYMENT-RESPONSE", b64(settled.settlement));
    await next();
    await Promise.resolve(o.onSettled?.({ route: c.req.path, paymentHash: settled.settlement.transaction, amountMsat: settled.amountMsat, priceUsd: route.priceUsd, status: c.res.status })).catch(() => undefined);
  };
}
