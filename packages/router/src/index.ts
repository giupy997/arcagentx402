/**
 * @cra-agent/router — the buyer-side rail.
 *
 *   rail.quote(url)  -> what would this cost, who is the seller, would policy allow it (no payment)
 *   rail.fetch(url)  -> pay if asked (x402), enforce policy at signing time, record everything in the ledger
 *
 * Nanopayments go through Circle Gateway (@circle-fin/x402-batching): signed off-chain, gas-free,
 * settled in batches. Sellers that do not batch fall back to the standard x402 "exact" on-chain scheme.
 * The escrow rail (ERC-8183) is routed but not executed yet.
 */
import { addUsdc6, compareUsdc6, formatUsdc6, headroomUsdc6, parseUsdc6, usdc6, type Usdc6 } from "@cra-agent/accounting";
import { CAIP2, type ArcNetwork, type IdentityResolver, type RailSigner } from "@cra-agent/identity";
import type { Ledger, PaymentRecord } from "@cra-agent/ledger";
import { describePolicy, evaluatePolicy, type PolicyContext, type PolicyDecision, type SpendPolicy } from "@cra-agent/policy";
import { supportsBatching } from "@circle-fin/x402-batching";
import { GatewayClient, registerBatchScheme } from "@circle-fin/x402-batching/client";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { checkLnbtcChallenge, msatToUsd6, payLnbtcChallenge, type PayerAdapter } from "@cra-agent/lightning";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { CHAINS } from "@cra-agent/identity";
import { chooseRail, DEFAULT_THRESHOLDS, type RouteDecision, type RouteThresholds } from "./decide.js";
import { policyHash, spendReceiptDomain, SPEND_RECEIPT_TYPES, toWire, type SignedSpendReceipt, type SpendReceiptMessage } from "./attest.js";

export * from "./attest.js";

export { chooseRail, DEFAULT_THRESHOLDS, type RailChoice, type RouteDecision, type RouteInput, type RouteThresholds } from "./decide.js";

export interface RailConfig {
  readonly network: ArcNetwork;
  readonly signer: RailSigner;
  readonly policy: SpendPolicy;
  readonly ledger: Ledger;
  /** null = identity checks disabled (policy.requireVerifiedIdentity then always fails closed). */
  readonly identity: IdentityResolver | null;
  readonly agentId: string;
  readonly rpcUrl?: string;
  readonly thresholds?: RouteThresholds;
  readonly fetch?: typeof globalThis.fetch;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
  /**
   * A Lightning wallet, for sellers that take bitcoin (x402 exact on lnbtc): it pays invoices and returns
   * their preimages. `rate` is BTC/USD, so a price in sats counts against limits written in dollars.
   */
  readonly lightning?: { readonly payer: PayerAdapter; readonly rate: () => Promise<{ rate: string }> };
}

export interface Quote {
  readonly url: string;
  readonly host: string;
  readonly price: Usdc6;
  readonly priceUsdc: string;
  readonly network: string;
  readonly scheme: string;
  readonly asset: string;
  readonly payTo: string;
  readonly batching: boolean;
  readonly route: RouteDecision;
  readonly policy: PolicyDecision;
  readonly identity: { verified: boolean; agentIds: string[]; error: string | null } | null;
  readonly resource: PaymentRequired["resource"];
  readonly options: number;
  /** The limits in force and where the agent stood against them when this was quoted. */
  readonly budget: Budget;
}

/** Amounts as USDC decimal strings. "Before" means before this payment. */
export interface Budget {
  readonly perPaymentCapUsdc: string;
  readonly dailyCapUsdc: string;
  readonly perSellerCapUsdc: string;
  readonly spentTodayBeforeUsdc: string;
  readonly spentWithSellerBeforeUsdc: string;
  /** What is left today and with this seller once this payment is counted. */
  readonly leftTodayAfterUsdc: string;
  readonly leftWithSellerAfterUsdc: string;
  /** Fingerprint of the whole policy, so a receipt can be tied to one exact set of limits. */
  readonly policyHash: string;
}

export interface Receipt {
  readonly ledgerId: number;
  readonly amount: Usdc6;
  readonly amountUsdc: string;
  readonly payTo: string;
  readonly network: string;
  /** not_charged: the seller's handler failed, so the signed payment was never settled. */
  readonly status: "settled" | "failed" | "not_charged";
  readonly txHash: string | null;
  readonly latencyMs: number;
  readonly reason: string | null;
  /** What was bought. */
  readonly resource: string;
  /** The limits this payment passed under, not only the rule that would have stopped it. */
  readonly budget: Budget | null;
  /** The same facts signed by the agent's key, for anyone who was not there. See verifySpendReceipt. */
  readonly attestation: SignedSpendReceipt | null;
}

export interface RailResponse {
  readonly response: Response;
  /** null when the resource did not require payment. */
  readonly receipt: Receipt | null;
}

export class PolicyRejected extends Error {
  override readonly name = "PolicyRejected";
  constructor(readonly decision: Exclude<PolicyDecision, { allow: true }>, readonly quote: Quote) {
    super(`payment rejected by policy (${decision.rule}): ${decision.reason}`);
  }
}

/** A Lightning payment that was not made: the challenge failed a check, or the wallet did not pay. */
export class LightningNotPaid extends Error {
  override readonly name = "LightningNotPaid";
  constructor(readonly reason: string) {
    super(`not paid over Lightning: ${reason}`);
  }
}

export class EscrowNotImplemented extends Error {
  override readonly name = "EscrowNotImplemented";
  constructor(readonly quote: Quote) {
    super(`this resource routes to the ERC-8183 escrow rail (${quote.route.reason}); escrow execution arrives in the next phase`);
  }
}

/**
 * The seller answered neither with a price (402) nor with success, so the call has no known cost.
 * Some sellers check the request before they ask for money: a POST without its body gets a 400.
 */
export class QuoteFailed extends Error {
  override readonly name = "QuoteFailed";
  constructor(readonly status: number, readonly detail: string) {
    super(`the seller answered ${status} instead of a price${detail ? `: ${detail}` : ""}`);
  }
}

/** USDC predeploy on Arc: same address on testnet and mainnet (docs.arc.io contract addresses, both tabs, 2026-09-16). */
export const ARC_USDC = "0x3600000000000000000000000000000000000000";
const DAY_MS = 24 * 3600 * 1000;
const hostOf = (url: string): string => { try { return new URL(url).host.toLowerCase(); } catch { return url; } };

export interface SettlementProof {
  readonly ledgerId: number;
  readonly amountUsdc: string;
  readonly payTo: string;
  readonly txHash: Hex;
  readonly blockNumber: number;
  readonly at: Date;
}

export interface Rail {
  /**
   * null only when the seller answers the call with success and asks nothing. Any other answer
   * throws QuoteFailed. Send the request as it will be paid: a POST with its body.
   */
  quote(url: string, init?: RequestInit): Promise<Quote | null>;
  /**
   * `maxUsdc` is a ceiling for this one call, checked like the policy: on the price the 402 asks at
   * pay time, before anything is signed. An agent that found a URL in a listing passes the listed
   * price, so a seller who raised it since is refused even when the new price is inside the limits.
   */
  fetch(url: string, init?: RequestInit, opts?: { maxUsdc?: string }): Promise<RailResponse>;
  /**
   * The same, paid in bitcoin over Lightning when the seller's 402 offers it: the invoice is checked
   * against this very request before anything is paid, its price in sats counts in dollars against the
   * policy, and the proof goes back with the retry. Needs `lightning` in the config.
   */
  fetchLightning(url: string, init?: RequestInit, opts?: { maxUsdc?: string }): Promise<RailResponse>;
  balances(): Promise<{ address: Address; wallet: string; gatewayAvailable: string; gatewayTotal: string }>;
  /**
   * Batched settlement means the money reaches the seller on chain later than the response.
   * This matches those on-chain transfers back to ledger rows, so every receipt ends up with a
   * transaction hash anyone can check. Returns the proofs found in this pass.
   */
  resolveSettlements(opts?: { limit?: number; lookbackBlocks?: number }): Promise<SettlementProof[]>;
  deposit(amountUsdc: string): Promise<{ txHash: Hex; amount: string }>;
  /**
   * Moves USDC from this key's Circle Gateway balance back to its wallet on the same chain: how a
   * seller collects what it was paid. Circle may charge a fee; `maxFeeUsdc` is the most this call
   * will accept, and it fails rather than pay more.
   */
  withdraw(amountUsdc: string, opts?: { maxFeeUsdc?: string }): Promise<{ txHash: Hex; amount: string; recipient: Address }>;
  readonly address: Address;
  readonly network: string;
}

export function createRail(cfg: RailConfig): Rail {
  const baseFetch = cfg.fetch ?? globalThis.fetch;
  const log = cfg.log ?? (() => {});
  const caip2 = CAIP2[cfg.network];
  const thresholds = cfg.thresholds ?? DEFAULT_THRESHOLDS;
  const signer = cfg.signer.account;

  // One x402 client; policy enforcement is a hook that runs BEFORE any signature exists.
  const client = new x402Client();
  registerBatchScheme(client, { signer, fallbackScheme: new ExactEvmScheme(signer) });
  // The core SDK only knows USDC on the chains it ships with; declare Arc's USDC explicitly so its own
  // spend control does not reject it. Our policy layer is the real limit; this is a second belt.
  // Uncapped here on purpose: the cap must come from OUR policy hook so the rejection is recorded in the ledger.
  client.setSpendControls({ maxAmountPerPayment: false, allowedAssets: [{ network: caip2 as `${string}:${string}`, asset: ARC_USDC }] });
  const httpClient = new x402HTTPClient(client);

  // Per-request state handed from the hooks to the fetch wrapper (hooks do not know the request).
  interface InFlight { url: string; method: string; startedAt: number; quote: Quote | null; record: PaymentRecord | null; rejected: PolicyRejected | null; spent: { today: Usdc6; withSeller: Usdc6 } | null; ceiling: Usdc6 | null }
  let current: InFlight | null = null;

  async function policyContext(req: PaymentRequirements, url: string): Promise<{ ctx: PolicyContext; identity: Quote["identity"] }> {
    const since = new Date(Date.now() - DAY_MS);
    const rateSince = new Date(Date.now() - cfg.policy.rateLimit.windowMs);
    const [spent, spentCp, count] = await Promise.all([cfg.ledger.spentSince(cfg.agentId, since), cfg.ledger.spentSince(cfg.agentId, since, req.payTo), cfg.ledger.countSince(cfg.agentId, rateSince)]);
    let identity: Quote["identity"] = null;
    if (cfg.identity) {
      const r = await cfg.identity.resolve(req.payTo as Address);
      identity = { verified: r.verified, agentIds: r.agentIds.map(String), error: r.error };
    }
    const ctx: PolicyContext = {
      amount: usdc6(BigInt(req.amount)), network: req.network, payTo: req.payTo, host: hostOf(url),
      spentInWindow: spent, spentInWindowWithCounterparty: spentCp, paymentsInRateWindow: count,
      identityVerified: identity ? identity.verified : null, sellerBond: null,
    };
    return { ctx, identity };
  }

  async function buildQuote(url: string, pr: PaymentRequired, req: PaymentRequirements): Promise<Quote> {
    const price = usdc6(BigInt(req.amount));
    const batching = supportsBatching(req);
    const route = chooseRail({ amount: price, kind: "call", supportsBatching: batching, maxTimeoutSeconds: req.maxTimeoutSeconds }, thresholds);
    const { ctx, identity } = await policyContext(req, url);
    const quote: Quote = { url, host: hostOf(url), price, priceUsdc: formatUsdc6(price), network: req.network, scheme: req.scheme, asset: req.asset, payTo: req.payTo, batching, route, policy: evaluatePolicy(cfg.policy, ctx), identity, resource: pr.resource, options: pr.accepts.length, budget: budgetOf(price, ctx) };
    spentAtQuote.set(quote, { today: ctx.spentInWindow, withSeller: ctx.spentInWindowWithCounterparty });
    return quote;
  }

  // The exact figures a decision was made on, kept beside the quote so the receipt can sign the same ones.
  const spentAtQuote = new WeakMap<Quote, { today: Usdc6; withSeller: Usdc6 }>();
  const fingerprint = policyHash(describePolicy(cfg.policy));
  function budgetOf(price: Usdc6, ctx: Pick<PolicyContext, "spentInWindow" | "spentInWindowWithCounterparty">): Budget {
    const p = cfg.policy;
    return {
      perPaymentCapUsdc: formatUsdc6(p.perPaymentCap),
      dailyCapUsdc: formatUsdc6(p.dailyCap),
      perSellerCapUsdc: formatUsdc6(p.perCounterpartyDailyCap),
      spentTodayBeforeUsdc: formatUsdc6(ctx.spentInWindow),
      spentWithSellerBeforeUsdc: formatUsdc6(ctx.spentInWindowWithCounterparty),
      leftTodayAfterUsdc: formatUsdc6(headroomUsdc6(p.dailyCap, addUsdc6(ctx.spentInWindow, price))),
      leftWithSellerAfterUsdc: formatUsdc6(headroomUsdc6(p.perCounterpartyDailyCap, addUsdc6(ctx.spentInWindowWithCounterparty, price))),
      policyHash: fingerprint,
    };
  }

  /** The receipt's facts, signed. The spent-before figures are the ones the policy decision was made on. */
  async function attest(rec: PaymentRecord, status: string, spent: { today: Usdc6; withSeller: Usdc6 }): Promise<SignedSpendReceipt | null> {
    try {
      const message: SpendReceiptMessage = {
        agent: cfg.signer.address, resource: rec.url, payTo: rec.payTo as Address, network: rec.network, amount: rec.amount, status,
        settlementId: rec.txHash ?? "", policyHash: fingerprint,
        perPaymentCap: cfg.policy.perPaymentCap, dailyCap: cfg.policy.dailyCap, perSellerCap: cfg.policy.perCounterpartyDailyCap,
        spentTodayBefore: spent.today, spentWithSellerBefore: spent.withSeller, issuedAt: BigInt(Math.floor(Date.now() / 1000)),
      };
      const domain = spendReceiptDomain(CHAINS[cfg.network].id);
      const signature = await cfg.signer.account.signTypedData({ domain, types: SPEND_RECEIPT_TYPES, primaryType: "SpendReceipt", message });
      return { domain, message: toWire(message), signature };
    } catch (err) {
      log("receipt.unsigned", { ledgerId: rec.id, error: (err as Error).message.slice(0, 120) });
      return null; // a receipt without a signature is still a receipt; the payment already happened
    }
  }

  /** Prefer our network and batched settlement; the SDK's default selector would take the first option. */
  function pickRequirements(accepts: PaymentRequirements[]): PaymentRequirements | null {
    const onArc = accepts.filter((a) => a.network === caip2);
    return onArc.find((a) => supportsBatching(a)) ?? onArc[0] ?? null;
  }

  client.onBeforePaymentCreation(async (ctx) => {
    const req = ctx.selectedRequirements;
    const inflight = current;
    const url = inflight?.url ?? ctx.paymentRequired.resource.url;
    const quote = await buildQuote(url, ctx.paymentRequired, req);
    if (inflight) {
      inflight.quote = quote;
      inflight.spent = spentAtQuote.get(quote) ?? null;
    }
    if (quote.route.rail === "escrow") {
      await cfg.ledger.record({ agentId: cfg.agentId, rail: "escrow", url, host: quote.host, method: inflight?.method ?? "GET", network: req.network, scheme: req.scheme, asset: req.asset, payTo: req.payTo, amount: quote.price, status: "rejected", reason: `escrow rail not executable yet: ${quote.route.reason}` });
      return { abort: true, reason: "escrow" };
    }
    // The caller's own ceiling for this call, on the live price, like the policy and at the same moment.
    const ceiling = inflight?.ceiling ?? null;
    if (quote.policy.allow && ceiling !== null && compareUsdc6(quote.price, ceiling) > 0) {
      const decision = { allow: false as const, rule: "max_price" as const, reason: `the seller asks ${quote.priceUsdc} USDC, above the ${formatUsdc6(ceiling)} USDC ceiling set for this call` };
      await cfg.ledger.record({ agentId: cfg.agentId, rail: "nanopayment", url, host: quote.host, method: inflight?.method ?? "GET", network: req.network, scheme: req.scheme, asset: req.asset, payTo: req.payTo, amount: quote.price, status: "rejected", reason: `${decision.rule}: ${decision.reason}` });
      if (inflight) inflight.rejected = new PolicyRejected(decision, quote);
      log("policy.rejected", { url, rule: decision.rule, reason: decision.reason });
      return { abort: true, reason: decision.reason };
    }
    if (!quote.policy.allow) {
      await cfg.ledger.record({ agentId: cfg.agentId, rail: "nanopayment", url, host: quote.host, method: inflight?.method ?? "GET", network: req.network, scheme: req.scheme, asset: req.asset, payTo: req.payTo, amount: quote.price, status: "rejected", reason: `${quote.policy.rule}: ${quote.policy.reason}` });
      if (inflight) inflight.rejected = new PolicyRejected(quote.policy, quote);
      log("policy.rejected", { url, rule: quote.policy.rule, reason: quote.policy.reason });
      return { abort: true, reason: quote.policy.reason };
    }
    return undefined;
  });

  client.onAfterPaymentCreation(async (ctx) => {
    const req = ctx.selectedRequirements;
    const inflight = current;
    const url = inflight?.url ?? ctx.paymentRequired.resource.url;
    const rec = await cfg.ledger.record({ agentId: cfg.agentId, rail: "nanopayment", url, host: hostOf(url), method: inflight?.method ?? "GET", network: req.network, scheme: req.scheme, asset: req.asset, payTo: req.payTo, amount: usdc6(BigInt(req.amount)), status: "signed", meta: { batching: supportsBatching(req) } });
    if (inflight) inflight.record = rec;
    log("payment.signed", { url, amount: req.amount, payTo: req.payTo, ledgerId: rec.id });
  });

  client.onPaymentResponse(async (ctx) => {
    const inflight = current;
    const rec = inflight?.record;
    if (!rec) return;
    // x402 settles only after a successful handler: a 4xx/5xx leaves the signature unspent.
    const httpFailed = ctx.settleResponse === undefined && ctx.error === undefined;
    const settled = ctx.settleResponse?.success === true;
    if (httpFailed) {
      await cfg.ledger.update(rec.id, { status: "quoted", reason: "not settled: the seller's handler failed, so the payment was never charged", latencyMs: inflight ? Date.now() - inflight.startedAt : null });
      rec.status = "quoted";
      rec.reason = "not settled: the seller's handler failed, so the payment was never charged";
      log("payment.not_charged", { ledgerId: rec.id, url: inflight?.url });
      return;
    }
    await cfg.ledger.update(rec.id, {
      status: settled ? "settled" : "failed",
      reason: settled ? null : ctx.settleResponse?.errorReason ?? ctx.error?.message ?? "settlement not confirmed",
      txHash: ctx.settleResponse?.transaction || null,
      payer: ctx.settleResponse?.payer ?? null,
      settledAt: settled ? new Date() : null,
      latencyMs: inflight ? Date.now() - inflight.startedAt : null,
    });
    rec.status = settled ? "settled" : "failed";
    rec.txHash = ctx.settleResponse?.transaction || null;
    rec.reason = settled ? null : ctx.settleResponse?.errorReason ?? null;
    log(settled ? "payment.settled" : "payment.failed", { ledgerId: rec.id, tx: rec.txHash, reason: rec.reason });
  });

  const payingFetch = wrapFetchWithPayment(baseFetch, client);

  return {
    address: cfg.signer.address,
    network: caip2,

    async quote(url, init) {
      const res = await baseFetch(url, { ...init, headers: { accept: "application/json", ...(init?.headers as Record<string, string> | undefined) } });
      if (res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return null;
      }
      if (res.status !== 402) {
        const said = await res.text().catch(() => "");
        throw new QuoteFailed(res.status, said.replace(/\s+/g, " ").trim().slice(0, 200));
      }
      const body = await res.json().catch(() => undefined);
      const pr = httpClient.getPaymentRequiredResponse((n) => res.headers.get(n), body);
      const req = pickRequirements(pr.accepts);
      if (!req) {
        return { url, host: hostOf(url), price: usdc6(0n), priceUsdc: "0", network: "-", scheme: "-", asset: "-", payTo: "-", batching: false, route: { rail: "nanopayment", reason: "n/a" }, policy: { allow: false, rule: "network", reason: `seller accepts no payment on ${caip2} (offers: ${pr.accepts.map((a) => a.network).join(", ")})` }, identity: null, resource: pr.resource, options: pr.accepts.length, budget: budgetOf(usdc6(0n), { spentInWindow: usdc6(0n), spentInWindowWithCounterparty: usdc6(0n) }) };
      }
      return buildQuote(url, pr, req);
    },

    async fetchLightning(url, init, opts = {}) {
      const wallet = cfg.lightning;
      if (!wallet) throw new LightningNotPaid("no Lightning wallet is configured for this agent");
      const startedAt = Date.now();
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = new Headers(init?.headers);
      if (!headers.has("accept")) headers.set("accept", "application/json");
      const first = await baseFetch(url, { ...init, headers });
      if (first.status !== 402) return { response: first, receipt: null };
      let pr: { accepts?: Array<Record<string, unknown>>; resource?: { url?: string } } | null = null;
      try {
        const h = first.headers.get("PAYMENT-REQUIRED");
        pr = h ? JSON.parse(Buffer.from(h, "base64").toString("utf8")) : ((await first.json()) as typeof pr);
      } catch {
        pr = null;
      }
      const offer = pr?.accepts?.find((a) => typeof a.network === "string" && a.network.startsWith("lnbtc:"));
      if (!offer) throw new LightningNotPaid(`the seller offers no Lightning payment (it takes ${(pr?.accepts ?? []).map((a) => String(a.network)).join(", ") || "nothing readable"})`);
      const body = typeof init?.body === "string" ? new TextEncoder().encode(init.body) : init?.body instanceof Uint8Array ? init.body : null;
      const checked = checkLnbtcChallenge(offer, { profile: "http:1", request: { method, url, body, header: (n) => headers.get(n) }, ...(pr?.resource?.url ? { resourceUrl: pr.resource.url } : {}) });
      if (!checked.ok) throw new LightningNotPaid(checked.reason);
      const req = checked.requirements;
      const amountMsat = checked.invoice.amountMsat!;
      const { rate } = await wallet.rate();
      const price = usdc6(msatToUsd6(amountMsat, rate));
      const since = new Date(Date.now() - DAY_MS);
      const [spent, spentCp, count] = await Promise.all([cfg.ledger.spentSince(cfg.agentId, since), cfg.ledger.spentSince(cfg.agentId, since, req.payTo), cfg.ledger.countSince(cfg.agentId, new Date(Date.now() - cfg.policy.rateLimit.windowMs))]);
      const ctx: PolicyContext = { amount: price, network: req.network, payTo: req.payTo, host: hostOf(url), spentInWindow: spent, spentInWindowWithCounterparty: spentCp, paymentsInRateWindow: count, identityVerified: null, sellerBond: null };
      const quote: Quote = { url, host: hostOf(url), price, priceUsdc: formatUsdc6(price), network: req.network, scheme: req.scheme, asset: req.asset, payTo: req.payTo, batching: false, route: { rail: "nanopayment", reason: "a Lightning invoice, paid at once" }, policy: evaluatePolicy(cfg.policy, ctx), identity: null, resource: (pr?.resource ?? { url }) as PaymentRequired["resource"], options: pr?.accepts?.length ?? 1, budget: budgetOf(price, ctx) };
      const base = { agentId: cfg.agentId, rail: "lightning" as const, url, host: quote.host, method, network: req.network, scheme: req.scheme, asset: req.asset, payTo: req.payTo, amount: price };
      const meta = { amountMsat, btcUsd: rate, paymentHash: checked.invoice.paymentHash };
      const ceiling = opts.maxUsdc === undefined ? null : parseUsdc6(opts.maxUsdc);
      const decision = quote.policy.allow && ceiling !== null && compareUsdc6(price, ceiling) > 0 ? { allow: false as const, rule: "max_price" as const, reason: `the seller asks ${quote.priceUsdc} USDC in sats, above the ${formatUsdc6(ceiling)} USDC ceiling set for this call` } : quote.policy;
      if (!decision.allow) {
        await cfg.ledger.record({ ...base, status: "rejected", reason: `${decision.rule}: ${decision.reason}`, meta });
        log("policy.rejected", { url, rule: decision.rule, reason: decision.reason });
        throw new PolicyRejected(decision, quote);
      }
      const rec = await cfg.ledger.record({ ...base, status: "signed", meta });
      const paid = await payLnbtcChallenge(checked, wallet.payer);
      if (!paid.ok) {
        const inFlight = paid.reason === "exact_lnbtc_payment_in_flight";
        await cfg.ledger.update(rec.id, { status: "failed", reason: inFlight ? "the wallet did not answer in time: the payment may still complete; do not pay again" : paid.reason, latencyMs: Date.now() - startedAt });
        throw new LightningNotPaid(paid.reason);
      }
      log("payment.signed", { ledgerId: rec.id, url, amountMsat, rail: "lightning" });
      const retry = new Headers(headers);
      retry.set("PAYMENT-SIGNATURE", Buffer.from(JSON.stringify(paid.payload)).toString("base64"));
      const response = await baseFetch(url, { ...init, headers: retry });
      let settlement: { success?: boolean; transaction?: string; errorReason?: string } | null = null;
      try {
        const h = response.headers.get("PAYMENT-RESPONSE");
        settlement = h ? JSON.parse(Buffer.from(h, "base64").toString("utf8")) : null;
      } catch {
        settlement = null;
      }
      const ok = settlement?.success === true && settlement.transaction === checked.invoice.paymentHash;
      let refusal: string | null = null;
      if (!ok && response.status === 402) {
        try {
          refusal = (JSON.parse(Buffer.from(response.headers.get("PAYMENT-REQUIRED") ?? "", "base64").toString("utf8")) as { error?: string }).error ?? null;
        } catch {
          refusal = null;
        }
      }
      // Lightning has settled before the seller looks at the proof: a refusal here is money spent for nothing.
      const reason = ok ? null : `paid ${amountMsat} msat, but the seller ${refusal ? `refused the proof: ${refusal}` : `answered ${response.status} without a receipt`}`;
      const latencyMs = Date.now() - startedAt;
      await cfg.ledger.update(rec.id, { status: ok ? "settled" : "failed", reason, txHash: checked.invoice.paymentHash, httpStatus: response.status, latencyMs, settledAt: new Date(), meta: { ...meta, feesMsat: paid.feesMsat } });
      log(ok ? "payment.settled" : "payment.failed", { ledgerId: rec.id, tx: checked.invoice.paymentHash, reason, rail: "lightning" });
      return {
        response,
        receipt: { ledgerId: rec.id, amount: price, amountUsdc: formatUsdc6(price), payTo: req.payTo, network: req.network, status: ok ? "settled" : "failed", txHash: checked.invoice.paymentHash, latencyMs, reason, resource: url, budget: quote.budget, attestation: null },
      };
    },

    async fetch(url, init, opts = {}) {
      const method = (init?.method ?? "GET").toUpperCase();
      current = { url, method, startedAt: Date.now(), quote: null, record: null, rejected: null, spent: null, ceiling: opts.maxUsdc === undefined ? null : parseUsdc6(opts.maxUsdc) };
      const mine = current;
      try {
        const response = await payingFetch(url, init);
        const rec = mine.record;
        if (!rec) return { response, receipt: null };
        if (rec.httpStatus === null) await cfg.ledger.update(rec.id, { httpStatus: response.status, latencyMs: Date.now() - mine.startedAt });
        const status = rec.status === "settled" ? "settled" : rec.status === "quoted" ? "not_charged" : "failed";
        const budget = mine.quote?.budget ?? null;
        const attestation = mine.spent ? await attest(rec, status, mine.spent) : null;
        // Kept with the row too, so the ledger can hand the same signed object back later.
        if (budget || attestation) await cfg.ledger.update(rec.id, { meta: { ...(rec.meta ?? {}), budget, attestation } });
        return {
          response,
          receipt: { ledgerId: rec.id, amount: rec.amount, amountUsdc: formatUsdc6(rec.amount), payTo: rec.payTo, network: rec.network, status, txHash: rec.txHash, latencyMs: Date.now() - mine.startedAt, reason: rec.reason, resource: rec.url, budget, attestation },
        };
      } catch (err) {
        if (mine.rejected) throw mine.rejected;
        if (mine.quote?.route.rail === "escrow") throw new EscrowNotImplemented(mine.quote);
        if (mine.record) await cfg.ledger.update(mine.record.id, { status: "failed", reason: (err as Error).message.slice(0, 300), latencyMs: Date.now() - mine.startedAt });
        throw err;
      } finally {
        if (current === mine) current = null;
      }
    },

    async resolveSettlements(opts = {}) {
      const pending = await cfg.ledger.awaitingProof(cfg.agentId, opts.limit ?? 20);
      if (pending.length === 0) return [];
      const gw = gatewayClient();
      const pub = createPublicClient({ chain: CHAINS[cfg.network], transport: http(cfg.rpcUrl) });
      const proofs: SettlementProof[] = [];
      for (const row of pending) {
        // Gateway stores the transfer under the id it returned at settlement time; it gains an
        // on-chain hash once the batch lands. Asking Circle beats guessing from logs.
        const transferId = row.txHash;
        if (!transferId || !/^[0-9a-f-]{36}$/i.test(transferId)) continue;
        type GatewayTransfer = { status?: string; txHash?: string; updatedAt?: string };
        let transfer: GatewayTransfer | null = null;
        try {
          transfer = (await gw.getTransferById(transferId)) as unknown as GatewayTransfer;
        } catch (err) {
          log("settlement.lookup_failed", { ledgerId: row.id, transferId, error: (err as Error).message.slice(0, 120) });
          continue;
        }
        const hash = transfer?.txHash;
        if (!hash || transfer?.status !== "completed") continue;
        let at = transfer.updatedAt ? new Date(transfer.updatedAt) : new Date();
        let blockNumber = 0;
        try {
          const receipt = await pub.getTransactionReceipt({ hash: hash as Hex });
          blockNumber = Number(receipt.blockNumber);
          const block = await pub.getBlock({ blockNumber: receipt.blockNumber });
          at = new Date(Number(block.timestamp) * 1000);
        } catch {
          /* the hash is enough; block details are a bonus */
        }
        await cfg.ledger.update(row.id, { settlementTx: hash, settledOnchainAt: at });
        proofs.push({ ledgerId: row.id, amountUsdc: formatUsdc6(row.amount), payTo: row.payTo, txHash: hash as Hex, blockNumber, at });
        log("settlement.proved", { ledgerId: row.id, txHash: hash, blockNumber });
      }
      return proofs;
    },

    async balances() {
      const gw = gatewayClient();
      const b = await gw.getBalances();
      return { address: cfg.signer.address, wallet: b.wallet.formatted, gatewayAvailable: b.gateway.formattedAvailable, gatewayTotal: b.gateway.formattedTotal };
    },

    async deposit(amountUsdc) {
      const gw = gatewayClient();
      const r = await gw.deposit(amountUsdc);
      return { txHash: r.depositTxHash, amount: r.formattedAmount };
    },

    async withdraw(amountUsdc, opts = {}) {
      const gw = gatewayClient();
      // The SDK's own ceiling is two dollars, more than most sellers on this rail earn in a week.
      const r = await gw.withdraw(amountUsdc, { maxFee: opts.maxFeeUsdc ?? "0.05" });
      return { txHash: r.mintTxHash, amount: r.formattedAmount, recipient: r.recipient };
    },
  };

  function gatewayClient(): GatewayClient {
    if (cfg.signer.scheme !== "secp256k1") throw new Error("Gateway deposits need a secp256k1 signer today");
    return new GatewayClient({ chain: cfg.network, privateKey: cfg.signer.privateKey, ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}) });
  }
}
