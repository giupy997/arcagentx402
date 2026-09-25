/**
 * A seller settling its Lightning proofs through an x402 facilitator instead of its own replay store: the
 * facilitator runs the same checks and keeps the one durable record of each payment hash. A seller must
 * pick one of the two for a node and keep it: proofs claimed in one store are unknown to the other.
 */
import type { LnbtcRequirements, LnbtcSettlement, LnbtcSettleError } from "./lnbtc.js";

export interface LnbtcFacilitatorClient {
  readonly url: string;
  /** Whether the facilitator lists `exact` on this `lnbtc` network. */
  supports(network: string): Promise<boolean>;
  /**
   * The facilitator's verdict on a proof. Throws when there is none to be had (unreachable, rate limited,
   * its store down): nothing was claimed then, and the same proof can be sent again.
   */
  settle(payload: unknown, requirements: LnbtcRequirements): Promise<LnbtcSettlement>;
}

export function lnbtcFacilitatorClient(url: string, o: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): LnbtcFacilitatorClient {
  const base = url.replace(/\/+$/, "");
  const doFetch = o.fetchImpl ?? fetch;
  const timeout = o.timeoutMs ?? 15_000;
  return {
    url: base,
    async supports(network) {
      try {
        const res = await doFetch(`${base}/supported`, { signal: AbortSignal.timeout(timeout) });
        const kinds = ((await res.json()) as { kinds?: Array<{ scheme?: unknown; network?: unknown }> }).kinds ?? [];
        return res.ok && kinds.some((k) => k.scheme === "exact" && k.network === network);
      } catch {
        return false;
      }
    },
    async settle(payload, requirements) {
      const res = await doFetch(`${base}/settle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements }),
        signal: AbortSignal.timeout(timeout),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`the facilitator answered ${res.status}: nothing was claimed, try the same proof again`);
      const body = (await res.json().catch(() => null)) as { success?: unknown; transaction?: unknown; errorReason?: unknown; network?: unknown } | null;
      if (body?.success === true && typeof body.transaction === "string" && /^[0-9a-f]{64}$/.test(body.transaction)) return { success: true, transaction: body.transaction, network: requirements.network };
      if (body?.success === false && typeof body.errorReason === "string") return { success: false, errorReason: body.errorReason as LnbtcSettleError, network: requirements.network };
      throw new Error(`the facilitator gave no verdict (HTTP ${res.status})`);
    },
  };
}
