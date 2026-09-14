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
import { formatUsdc6, usdc6, type Usdc6 } from "@cra-agent/accounting";
import { CAIP2, type ArcNetwork, type IdentityResolver, type RailSigner } from "@cra-agent/identity";
import type { Ledger, PaymentRecord } from "@cra-agent/ledger";
import { evaluatePolicy, type PolicyContext, type PolicyDecision, type SpendPolicy } from "@cra-agent/policy";
import { supportsBatching } from "@circle-fin/x402-batching";
import { GatewayClient, registerBatchScheme } from "@circle-fin/x402-batching/client";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import type { Address, Hex } from "viem";
import { chooseRail, DEFAULT_THRESHOLDS, type RouteDecision, type RouteThresholds } from "./decide.js";

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
}

export interface Receipt {
  readonly ledgerId: number;
  readonly amount: Usdc6;
  readonly amountUsdc: string;
  readonly payTo: string;
  readonly network: string;
  readonly status: "settled" | "failed";
  readonly txHash: string | null;
  readonly latencyMs: number;
  readonly reason: string | null;
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

export class EscrowNotImplemented extends Error {
  override readonly name = "EscrowNotImplemented";
  constructor(readonly quote: Quote) {
    super(`this resource routes to the ERC-8183 escrow rail (${quote.route.reason}); escrow execution arrives in the next phase`);
  }
}

/** USDC predeploy on Arc (docs.arc.io contract addresses, testnet; same address assumed on mainnet, verified at startup by the collector). */
export const ARC_USDC = "0x3600000000000000000000000000000000000000";
const DAY_MS = 24 * 3600 * 1000;
const hostOf = (url: string): string => { try { return new URL(url).host.toLowerCase(); } catch { return url; } };

export interface Rail {
  quote(url: string, init?: RequestInit): Promise<Quote | null>;
  fetch(url: string, init?: RequestInit): Promise<RailResponse>;
  balances(): Promise<{ address: Address; wallet: string; gatewayAvailable: string; gatewayTotal: string }>;
  deposit(amountUsdc: string): Promise<{ txHash: Hex; amount: string }>;
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
  interface InFlight { url: string; method: string; startedAt: number; quote: Quote | null; record: PaymentRecord | null; rejected: PolicyRejected | null }
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
    return { url, host: hostOf(url), price, priceUsdc: formatUsdc6(price), network: req.network, scheme: req.scheme, asset: req.asset, payTo: req.payTo, batching, route, policy: evaluatePolicy(cfg.policy, ctx), identity, resource: pr.resource, options: pr.accepts.length };
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
    if (inflight) inflight.quote = quote;
    if (quote.route.rail === "escrow") {
      await cfg.ledger.record({ agentId: cfg.agentId, rail: "escrow", url, host: quote.host, method: inflight?.method ?? "GET", network: req.network, scheme: req.scheme, asset: req.asset, payTo: req.payTo, amount: quote.price, status: "rejected", reason: `escrow rail not executable yet: ${quote.route.reason}` });
      return { abort: true, reason: "escrow" };
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
    const settled = ctx.settleResponse?.success === true;
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
      if (res.status !== 402) return null;
      const body = await res.json().catch(() => undefined);
      const pr = httpClient.getPaymentRequiredResponse((n) => res.headers.get(n), body);
      const req = pickRequirements(pr.accepts);
      if (!req) {
        return { url, host: hostOf(url), price: usdc6(0n), priceUsdc: "0", network: "-", scheme: "-", asset: "-", payTo: "-", batching: false, route: { rail: "nanopayment", reason: "n/a" }, policy: { allow: false, rule: "network", reason: `seller accepts no payment on ${caip2} (offers: ${pr.accepts.map((a) => a.network).join(", ")})` }, identity: null, resource: pr.resource, options: pr.accepts.length };
      }
      return buildQuote(url, pr, req);
    },

    async fetch(url, init) {
      const method = (init?.method ?? "GET").toUpperCase();
      current = { url, method, startedAt: Date.now(), quote: null, record: null, rejected: null };
      const mine = current;
      try {
        const response = await payingFetch(url, init);
        const rec = mine.record;
        if (!rec) return { response, receipt: null };
        if (rec.httpStatus === null) await cfg.ledger.update(rec.id, { httpStatus: response.status, latencyMs: Date.now() - mine.startedAt });
        return {
          response,
          receipt: { ledgerId: rec.id, amount: rec.amount, amountUsdc: formatUsdc6(rec.amount), payTo: rec.payTo, network: rec.network, status: rec.status === "settled" ? "settled" : "failed", txHash: rec.txHash, latencyMs: Date.now() - mine.startedAt, reason: rec.reason },
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
  };

  function gatewayClient(): GatewayClient {
    if (cfg.signer.scheme !== "secp256k1") throw new Error("Gateway deposits need a secp256k1 signer today");
    const privateKey = (cfg.signer.account as unknown as { privateKey?: Hex }).privateKey;
    if (!privateKey) throw new Error("signer does not expose a private key for Gateway deposit/balance calls");
    return new GatewayClient({ chain: cfg.network, privateKey, ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}) });
  }
}
