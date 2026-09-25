/**
 * Our facilitator for x402 `exact` on `lnbtc`, open to any seller, without registration.
 *
 * Settling a Lightning payment moves nothing: the sats reached the seller's node before its buyer had the
 * preimage. What a facilitator adds is the check of the proof against the seller's requirements and one
 * durable claim of `network:payment_hash`, shared by everything that settles for the same node. That costs
 * us a row in Postgres, not gas, so nobody has to register. The rows stay bounded: an invoice may last an
 * hour at most here, which lets every claim be pruned a few hours later, and new claims are paced per
 * address and capped per day. A proof is a bearer secret: nothing here logs one.
 */
import { LNBTC_MAINNET, LNBTC_TESTNET, settleLnbtc, type LnbtcRequirements, type ReplayStore } from "@cra-agent/lightning";

export const LNBTC_KINDS = [LNBTC_MAINNET, LNBTC_TESTNET].map((network) => ({ x402Version: 2, scheme: "exact", network }));

export interface LnbtcSettledHere {
  readonly network: string;
  readonly paymentHash: string;
  readonly payTo: string;
  readonly amountMsat: string;
}

export interface LnbtcFacilitatorOptions {
  readonly replay: ReplayStore;
  /** Invoices that last longer are refused. Default 3,600 seconds. */
  readonly maxTimeoutSeconds?: number;
  /** Settlement calls per client address per minute. Default 60. */
  readonly perMinute?: number;
  /** Successful settlements for everyone per UTC day. Default 20,000. */
  readonly dailyCap?: number;
  /** How many were settled today before this process started. */
  readonly settledEarlierToday?: () => Promise<number>;
  readonly onSettled?: (e: LnbtcSettledHere) => void | Promise<void>;
  /** Milliseconds. */
  readonly now?: () => number;
}

export interface Answer {
  readonly status: 200 | 400 | 429 | 503;
  readonly json: Record<string, unknown>;
}

type Body = { paymentPayload?: { accepted?: { network?: unknown } }; paymentRequirements?: Partial<LnbtcRequirements> } | null;

/** A /verify or /settle body for Lightning, by the network either side names. */
export function isLnbtcBody(body: unknown): boolean {
  const b = body as Body;
  const n = [b?.paymentRequirements?.network, b?.paymentPayload?.accepted?.network];
  return n.some((v) => typeof v === "string" && v.startsWith("lnbtc:"));
}

export function lnbtcFacilitator(o: LnbtcFacilitatorOptions) {
  const maxTimeout = o.maxTimeoutSeconds ?? 3600;
  const perMinute = o.perMinute ?? 60;
  const dailyCap = o.dailyCap ?? 20_000;
  const now = o.now ?? Date.now;
  let minute = 0;
  const calls = new Map<string, number>();
  let day = "";
  let today: Promise<number> | number = 0;

  const utcDay = () => new Date(now()).toISOString().slice(0, 10);
  const settledToday = async (): Promise<number> => {
    if (day !== utcDay()) {
      // The first count of a day comes from the store, so a restart does not reopen the cap.
      const first = day === "";
      day = utcDay();
      today = first && o.settledEarlierToday ? o.settledEarlierToday().catch(() => 0) : 0;
    }
    return today;
  };
  const paced = (client: string): boolean => {
    const m = Math.floor(now() / 60_000);
    if (m !== minute) {
      minute = m;
      calls.clear();
    }
    const n = calls.get(client) ?? 0;
    calls.set(client, n + 1);
    return n >= perMinute;
  };
  const refusal = (errorReason: string, network: unknown, extra: Record<string, unknown> = {}) => ({ success: false, errorReason, transaction: "", network: typeof network === "string" ? network : "", ...extra });

  return {
    kinds: LNBTC_KINDS,
    limits: { maxTimeoutSeconds: maxTimeout, perMinute, dailyCap },
    settledToday,

    /** The spec's flow never calls /verify: the proof is settled, then the request served. */
    verify(): Answer {
      return { status: 400, json: { isValid: false, invalidReason: "invalid_exact_lnbtc_payment_flow", invalidMessage: "exact on lnbtc is paid up front: send the payload to /settle, and serve the request only once it succeeds. /verify is not part of this flow." } };
    },

    async settle(body: unknown, client: string): Promise<Answer> {
      const b = body as Body;
      const req = b?.paymentRequirements;
      // Every call counts, a malformed one too.
      if (paced(client)) return { status: 429, json: refusal("rate_limited", req?.network, { errorMessage: `at most ${perMinute} settlement calls a minute from one address; nothing was claimed` }) };
      if (!b?.paymentPayload || typeof b.paymentPayload !== "object" || !req || typeof req !== "object") return { status: 400, json: refusal("invalid_request", null, { errorMessage: "expected { paymentPayload, paymentRequirements }" }) };
      if ((await settledToday()) >= dailyCap) return { status: 503, json: refusal("daily_cap_reached", req.network, { errorMessage: "this facilitator has settled all it settles today; nothing was claimed, try again after 00:00 UTC" }) };
      // A claim is kept an hour past the invoice's end: a bound on the invoice is a bound on the table.
      if (typeof req.maxTimeoutSeconds === "number" && req.maxTimeoutSeconds > maxTimeout) return { status: 200, json: refusal("invalid_exact_lnbtc_max_timeout", req.network, { errorMessage: `this facilitator settles invoices that last at most ${maxTimeout} seconds` }) };
      let settled;
      try {
        settled = await settleLnbtc(b.paymentPayload, req, { replay: o.replay, now: Math.floor(now() / 1000) });
      } catch {
        return { status: 503, json: refusal("replay_store_unavailable", req.network, { errorMessage: "nothing was claimed; send the same proof again shortly" }) };
      }
      if (!settled.success) return { status: 200, json: refusal(settled.errorReason, req.network) };
      today = (await settledToday()) + 1;
      await Promise.resolve(o.onSettled?.({ network: settled.network, paymentHash: settled.transaction, payTo: String(req.payTo), amountMsat: String(req.amount) })).catch(() => undefined);
      // No payer: Lightning does not reveal one, and the spec forbids inferring it.
      return { status: 200, json: { success: true, transaction: settled.transaction, network: settled.network } };
    },
  };
}

export type LnbtcFacilitator = ReturnType<typeof lnbtcFacilitator>;
