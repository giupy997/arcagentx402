/**
 * Selling for sats with `exact` on `lnbtc`, apart from any web framework: the challenge a 402 carries, with a
 * fresh invoice bound to the request, and the settlement of a paid retry, which must happen before the
 * request is served. Our API and the seller's proxy put their own HTTP around it.
 */
import { usdToMsat } from "./amounts.js";
import { httpBinding } from "./binding.js";
import type { BtcUsd } from "./btcusd.js";
import type { LnbtcFacilitatorClient } from "./facilitator-client.js";
import { issueLnbtcChallenge, settleLnbtc, type LnbtcRequirements, type LnbtcSettlement, type LnbtcSettleError, type ReceiverAdapter, type ReplayStore } from "./lnbtc.js";

export interface LnbtcPaywallOptions {
  readonly receiver: () => Promise<ReceiverAdapter>;
  readonly network: string;
  /** Where proofs are claimed, here. Give this or `facilitator`, never both for one node. */
  readonly replay?: ReplayStore;
  /** A facilitator that checks and claims proofs in its own store, in place of `replay`. */
  readonly facilitator?: LnbtcFacilitatorClient;
  readonly rate: () => Promise<BtcUsd>;
  /** The least an invoice asks, in millisatoshis. Default 1,000: one sat. */
  readonly minMsat?: bigint;
  /** How long an invoice can be paid. Default 300 seconds. */
  readonly maxTimeoutSeconds?: number;
  /** A paid retry keeps the amount its invoice named when that is within this share of today's price. Default 5%. */
  readonly tolerance?: number;
  /** New invoices per client per minute, and for everyone per minute. Default 30 and 600. */
  readonly limits?: { readonly perClient: number; readonly total: number };
  /** Milliseconds. */
  readonly now?: () => number;
}

/** One request, as the buyer sent it: `url` is the public URL they called, escapes and query order kept. */
export interface LnbtcSale {
  readonly method: string;
  readonly url: string;
  readonly body: Uint8Array | null;
  readonly header: (name: string) => string | null;
  /** Dollars, as a decimal string. */
  readonly priceUsd: string;
}

export type LnbtcOffer =
  | { readonly ok: true; readonly requirements: LnbtcRequirements; readonly btcUsd: string }
  | { readonly ok: false; readonly status: 429 | 503; readonly error: "no_rate" | "exact_lnbtc_invoice_issuance_denied" | "node_unavailable" };

export type LnbtcSettled =
  | { readonly ok: true; readonly settlement: { readonly success: true; readonly transaction: string; readonly network: string }; readonly amountMsat: string }
  | { readonly ok: false; readonly status: 402; readonly error: LnbtcSettleError }
  | { readonly ok: false; readonly status: 503; readonly error: "node_unavailable" | "replay_store_unavailable" | "facilitator_unavailable" };

export interface LnbtcPaywall {
  /** A fresh invoice for this request, or why there is none. `client` is who asks, for the issuance limit. */
  offer(sale: LnbtcSale, client: string): Promise<LnbtcOffer>;
  /** Checks a proof against the request that will run, and claims it once. Serve only after `ok`. */
  settle(sale: LnbtcSale, payment: string): Promise<LnbtcSettled>;
}

/** The network of a payment header, when it decodes: a proof for `lnbtc` goes to `settle`, anything else elsewhere. */
export function paymentNetwork(payment: string): string | null {
  try {
    const n = (JSON.parse(Buffer.from(payment, "base64").toString("utf8")) as { accepted?: { network?: unknown } } | null)?.accepted?.network;
    return typeof n === "string" ? n : null;
  } catch {
    return null;
  }
}

/** Fixed windows of a minute: enough to keep one client from making the node write invoices all day. */
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

export function lnbtcPaywall(o: LnbtcPaywallOptions): LnbtcPaywall {
  if (!o.replay === !o.facilitator) throw new Error("give a replay store or a facilitator, one of the two");
  const minMsat = o.minMsat ?? 1000n;
  const maxTimeoutSeconds = o.maxTimeoutSeconds ?? 300;
  const tolerance = o.tolerance ?? 0.05;
  const now = o.now ?? Date.now;
  const allow = limiter(o.limits?.perClient ?? 30, o.limits?.total ?? 600, now);
  const params = { headers: [] as string[] };
  const bound = (s: LnbtcSale) => httpBinding({ method: s.method, url: s.url, body: s.body, header: s.header }, params).requestHash;
  const todayMsat = async (priceUsd: string) => {
    const rate = await o.rate().catch(() => null);
    return rate ? { rate: rate.rate, msat: BigInt(usdToMsat(priceUsd, rate.rate, minMsat)) } : null;
  };

  return {
    async offer(sale, client) {
      const today = await todayMsat(sale.priceUsd);
      if (!today) return { ok: false, status: 503, error: "no_rate" };
      if (!allow(client)) return { ok: false, status: 429, error: "exact_lnbtc_invoice_issuance_denied" };
      try {
        const requirements = await issueLnbtcChallenge({ receiver: await o.receiver(), network: o.network, amountMsat: today.msat.toString(), maxTimeoutSeconds, profile: "http:1", params, requestHash: bound(sale), now: Math.floor(now() / 1000) });
        return { ok: true, requirements, btcUsd: today.rate };
      } catch {
        return { ok: false, status: 503, error: "node_unavailable" };
      }
    },

    async settle(sale, payment) {
      type Proof = { accepted?: { amount?: unknown; extra?: { invoice?: unknown } } } | null;
      let proof = null as Proof;
      try {
        proof = JSON.parse(Buffer.from(payment, "base64").toString("utf8")) as Proof;
      } catch {
        proof = null;
      }
      // The amount the invoice named stands if the rate has moved little since, or if no rate can be read now:
      // the invoice is this node's, bound to this request and minutes old, and its buyer has already paid it.
      // Otherwise today's price, and the proof fails on the amount. The binding is always recomputed here.
      const today = await todayMsat(sale.priceUsd);
      const named = typeof proof?.accepted?.amount === "string" && /^[1-9][0-9]*$/.test(proof.accepted.amount) ? BigInt(proof.accepted.amount) : null;
      const close = named !== null && named >= minMsat && (today === null || Math.abs(Number(named - today.msat)) <= Number(today.msat) * tolerance);
      const invoice = typeof proof?.accepted?.extra?.invoice === "string" ? proof.accepted.extra.invoice : "";
      const receiver = await o.receiver().catch(() => null);
      if (!receiver) return { ok: false, status: 503, error: "node_unavailable" };
      const requirements: LnbtcRequirements = {
        scheme: "exact",
        network: o.network,
        amount: (close ? named! : (today?.msat ?? named ?? 0n)).toString(),
        asset: "BTC",
        payTo: receiver.pubkey,
        maxTimeoutSeconds,
        extra: { assetTransferMethod: "bolt11", paymentFlow: "upfront", requestHash: bound(sale), requestBindingProfile: "http:1", requestBindingParams: params, invoice },
      };
      let settled: LnbtcSettlement;
      try {
        settled = o.facilitator ? await o.facilitator.settle(proof, requirements) : await settleLnbtc(proof, requirements, { replay: o.replay!, now: Math.floor(now() / 1000) });
      } catch {
        // Nothing was claimed: the same proof can come back once the store answers again.
        return { ok: false, status: 503, error: o.facilitator ? "facilitator_unavailable" : "replay_store_unavailable" };
      }
      if (!settled.success) return { ok: false, status: 402, error: settled.errorReason };
      return { ok: true, settlement: settled, amountMsat: requirements.amount };
    },
  };
}
