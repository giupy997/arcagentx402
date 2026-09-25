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
import { httpBinding, issueLnbtcChallenge, settleLnbtc, usdToMsat, type BtcUsd, type LnbtcRequirements, type ReceiverAdapter, type ReplayStore } from "@cra-agent/lightning";

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

/** Fixed windows of a minute: enough to keep one client from making our node write invoices all day. */
function limiter(perClient: number, total: number, now: () => number) {
  let window = 0;
  let all = 0;
  const counts = new Map<string, number>();
  return (client: string): boolean => {
    const w = Math.floor(now() / 60_000);
    if (w !== window) {
      window = w;
      all = 0;
      counts.clear();
    }
    const n = counts.get(client) ?? 0;
    if (n >= perClient || all >= total) return false;
    counts.set(client, n + 1);
    all++;
    return true;
  };
}

export function lightningMiddleware(o: LightningOptions): MiddlewareHandler {
  const minMsat = o.minMsat ?? 1000n;
  const maxTimeoutSeconds = o.maxTimeoutSeconds ?? 300;
  const tolerance = o.tolerance ?? 0.05;
  const now = o.now ?? Date.now;
  const allow = limiter(o.limits?.perClient ?? 30, o.limits?.total ?? 600, now);
  const byPath = new Map(o.routes.map((r) => [r.path, r]));

  return async (c, next) => {
    const route = c.req.method === "GET" ? byPath.get(c.req.path) : undefined;
    if (!route) return next();
    const url = publicUrl(c, o.publicOrigin);
    const params = { headers: [] as string[] };
    const { requestHash } = httpBinding({ method: c.req.method, url, body: null, header: (n) => c.req.header(n) ?? null }, params);
    const rate = await o.rate().catch(() => null);
    const today = rate ? BigInt(usdToMsat(route.priceUsd, rate.rate, minMsat)) : null;
    const resource = { url, description: route.description, mimeType: "application/json" };
    const payment = c.req.header("payment-signature") ?? c.req.header("x-payment");

    if (!payment) {
      if (!rate || today === null) return c.json({ error: "no reliable BTC/USD rate right now, so no price in sats; the /v1/paid rails still work" }, 503);
      const client = (c.req.header("x-forwarded-for") ?? "").split(",")[0]!.trim() || "direct";
      if (!allow(client)) return c.json({ error: "exact_lnbtc_invoice_issuance_denied", detail: "too many new invoices from this address; try again in a minute" }, 429);
      let requirements: LnbtcRequirements;
      try {
        requirements = await issueLnbtcChallenge({ receiver: await o.receiver(), network: o.network, amountMsat: today.toString(), maxTimeoutSeconds, profile: "http:1", params, requestHash, now: Math.floor(now() / 1000) });
      } catch {
        return c.json({ error: "our Lightning node did not issue an invoice; the /v1/paid rails still work" }, 503);
      }
      const required = { x402Version: 2, error: "Payment required", resource, accepts: [requirements] };
      return c.json({ ...required, priceUsd: route.priceUsd, btcUsd: rate.rate }, 402, { "PAYMENT-REQUIRED": b64(required) });
    }

    type Proof = { accepted?: { amount?: unknown; extra?: { invoice?: unknown } } } | null;
    let payload = null as Proof;
    try {
      payload = JSON.parse(Buffer.from(payment, "base64").toString("utf8")) as Proof;
    } catch {
      payload = null;
    }
    // The amount our invoice named stands if the rate has moved little since, or if no rate can be read now:
    // the invoice is ours, bound to this request and minutes old, and its buyer has already paid it. Otherwise
    // today's price, and the proof fails on the amount. The binding is always recomputed from this request.
    const named = typeof payload?.accepted?.amount === "string" && /^[1-9][0-9]*$/.test(payload.accepted.amount) ? BigInt(payload.accepted.amount) : null;
    const close = named !== null && named >= minMsat && (today === null || Math.abs(Number(named - today)) <= Number(today) * tolerance);
    const invoice = typeof payload?.accepted?.extra?.invoice === "string" ? payload.accepted.extra.invoice : "";
    const receiver = await o.receiver().catch(() => null);
    if (!receiver) return c.json({ error: "our Lightning node is not reachable right now" }, 503);
    const requirements: LnbtcRequirements = {
      scheme: "exact",
      network: o.network,
      amount: (close ? named! : (today ?? named ?? 0n)).toString(),
      asset: "BTC",
      payTo: receiver.pubkey,
      maxTimeoutSeconds,
      extra: { assetTransferMethod: "bolt11", paymentFlow: "upfront", requestHash, requestBindingProfile: "http:1", requestBindingParams: params, invoice },
    };
    const settled = await settleLnbtc(payload, requirements, { replay: o.replay, now: Math.floor(now() / 1000) });
    if (!settled.success) {
      const refused = { x402Version: 2, error: settled.errorReason, resource, accepts: [] };
      return c.json(refused, 402, { "PAYMENT-REQUIRED": b64(refused) });
    }
    c.header("PAYMENT-RESPONSE", b64(settled));
    await next();
    await Promise.resolve(o.onSettled?.({ route: c.req.path, paymentHash: settled.transaction, amountMsat: requirements.amount, priceUsd: route.priceUsd, status: c.res.status })).catch(() => undefined);
  };
}
