/**
 * @cra-agent/policy — spend control for agent payments.
 *
 * Pure: no I/O. The caller (router) gathers the context from the ledger and the identity layer and
 * asks for a decision. Enforcement lives at the account (the rail signs nothing the policy rejects),
 * never in the agent's prompt. The interface is the phase-2 product: keep it stable.
 */
import { addUsdc6, compareUsdc6, formatUsdc6, parseUsdc6, usdc6, type Usdc6 } from "@cra-agent/accounting";

export interface SpendPolicy {
  /** Max for a single payment. */
  readonly perPaymentCap: Usdc6;
  /** Max total in a rolling 24h window. */
  readonly dailyCap: Usdc6;
  /** Max to one counterparty (payTo address) in a rolling 24h window. */
  readonly perCounterpartyDailyCap: Usdc6;
  /** Max number of payments in a rolling window. */
  readonly rateLimit: { readonly maxPayments: number; readonly windowMs: number };
  /** Hostnames or payTo addresses (lowercase). null = any. */
  readonly allowlist: readonly string[] | null;
  readonly denylist: readonly string[];
  /** CAIP-2 networks the rail may pay on (e.g. "eip155:5042"). */
  readonly allowedNetworks: readonly string[];
  /** Fail closed on sellers without a verified ERC-8004 identity. */
  readonly requireVerifiedIdentity: boolean;
  /** Phase 2 extension point: minimum bond a seller must have posted. 0 = not required. */
  readonly requiredSellerBond: Usdc6;
}

export interface PolicyContext {
  readonly amount: Usdc6;
  readonly network: string;
  readonly payTo: string;
  readonly host: string;
  readonly spentInWindow: Usdc6;
  readonly spentInWindowWithCounterparty: Usdc6;
  readonly paymentsInRateWindow: number;
  /** null = not checked (identity layer unavailable) — treated as unverified when required. */
  readonly identityVerified: boolean | null;
  /** null = unknown. */
  readonly sellerBond: Usdc6 | null;
}

export type PolicyRule = "network" | "denylist" | "allowlist" | "per_payment" | "rate" | "daily" | "per_counterparty" | "identity" | "bond";

export type PolicyDecision = { readonly allow: true } | { readonly allow: false; readonly rule: PolicyRule; readonly reason: string };

export const ARC_MAINNET = "eip155:5042";
export const ARC_TESTNET = "eip155:5042002";

export const DEFAULT_POLICY: SpendPolicy = {
  perPaymentCap: parseUsdc6("0.05"),
  dailyCap: parseUsdc6("5"),
  perCounterpartyDailyCap: parseUsdc6("1"),
  rateLimit: { maxPayments: 120, windowMs: 60_000 },
  allowlist: null,
  denylist: [],
  allowedNetworks: [ARC_MAINNET, ARC_TESTNET],
  requireVerifiedIdentity: false,
  requiredSellerBond: usdc6(0n),
};

const norm = (s: string) => s.trim().toLowerCase();

/** Ordered checks. The first failing rule wins; the reason is meant for the ledger and the agent. */
export function evaluatePolicy(policy: SpendPolicy, ctx: PolicyContext): PolicyDecision {
  const deny = (rule: PolicyRule, reason: string): PolicyDecision => ({ allow: false, rule, reason });
  if (!policy.allowedNetworks.includes(ctx.network)) return deny("network", `network ${ctx.network} not allowed`);
  const host = norm(ctx.host);
  const payTo = norm(ctx.payTo);
  if (policy.denylist.some((d) => norm(d) === host || norm(d) === payTo)) return deny("denylist", `${ctx.host} / ${ctx.payTo} is denied`);
  if (policy.allowlist !== null && !policy.allowlist.some((a) => norm(a) === host || norm(a) === payTo)) return deny("allowlist", `${ctx.host} / ${ctx.payTo} not in allowlist`);
  if (compareUsdc6(ctx.amount, policy.perPaymentCap) > 0) return deny("per_payment", `${formatUsdc6(ctx.amount)} USDC exceeds per-payment cap ${formatUsdc6(policy.perPaymentCap)}`);
  if (ctx.paymentsInRateWindow >= policy.rateLimit.maxPayments) return deny("rate", `${ctx.paymentsInRateWindow} payments in ${policy.rateLimit.windowMs / 1000}s window (max ${policy.rateLimit.maxPayments})`);
  const afterDaily = addUsdc6(ctx.spentInWindow, ctx.amount);
  if (compareUsdc6(afterDaily, policy.dailyCap) > 0) return deny("daily", `would reach ${formatUsdc6(afterDaily)} USDC in 24h, cap ${formatUsdc6(policy.dailyCap)}`);
  const afterCp = addUsdc6(ctx.spentInWindowWithCounterparty, ctx.amount);
  if (compareUsdc6(afterCp, policy.perCounterpartyDailyCap) > 0) return deny("per_counterparty", `would reach ${formatUsdc6(afterCp)} USDC with ${ctx.payTo} in 24h, cap ${formatUsdc6(policy.perCounterpartyDailyCap)}`);
  if (policy.requireVerifiedIdentity && ctx.identityVerified !== true) return deny("identity", ctx.identityVerified === null ? "seller identity could not be checked" : "seller has no verified ERC-8004 identity");
  if (policy.requiredSellerBond > 0n) {
    if (ctx.sellerBond === null) return deny("bond", "seller bond unknown");
    if (compareUsdc6(ctx.sellerBond, policy.requiredSellerBond) < 0) return deny("bond", `seller bond ${formatUsdc6(ctx.sellerBond)} below required ${formatUsdc6(policy.requiredSellerBond)}`);
  }
  return { allow: true };
}

/**
 * Compact env/CLI syntax, e.g. CRA_POLICY="daily=5,per_seller=0.5,per_payment=0.05,rate=60/60s,identity=required,allow=api.a.com|0xabc"
 * Unknown keys throw: a typo in a spend limit must not silently widen it.
 */
export function parsePolicyString(text: string, base: SpendPolicy = DEFAULT_POLICY): SpendPolicy {
  let p: SpendPolicy = { ...base };
  for (const part of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq < 0) throw new Error(`policy: expected key=value, got "${part}"`);
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    switch (key) {
      case "daily": p = { ...p, dailyCap: parseUsdc6(value) }; break;
      case "per_seller": p = { ...p, perCounterpartyDailyCap: parseUsdc6(value) }; break;
      case "per_payment": p = { ...p, perPaymentCap: parseUsdc6(value) }; break;
      case "rate": {
        const m = /^(\d+)\/(\d+)(s|m|h)$/.exec(value);
        if (!m) throw new Error(`policy: rate must look like 60/60s, got "${value}"`);
        const mult = m[3] === "s" ? 1000 : m[3] === "m" ? 60_000 : 3_600_000;
        p = { ...p, rateLimit: { maxPayments: Number(m[1]), windowMs: Number(m[2]) * mult } };
        break;
      }
      case "allow": p = { ...p, allowlist: value === "*" ? null : value.split("|").map(norm) }; break;
      case "deny": p = { ...p, denylist: value.split("|").map(norm) }; break;
      case "networks": p = { ...p, allowedNetworks: value.split("|").map((s) => s.trim()) }; break;
      case "identity": p = { ...p, requireVerifiedIdentity: value === "required" }; break;
      case "bond": p = { ...p, requiredSellerBond: parseUsdc6(value) }; break;
      default: throw new Error(`policy: unknown key "${key}"`);
    }
  }
  return p;
}

export function describePolicy(p: SpendPolicy): Record<string, unknown> {
  return {
    perPaymentCapUsdc: formatUsdc6(p.perPaymentCap),
    dailyCapUsdc: formatUsdc6(p.dailyCap),
    perCounterpartyDailyCapUsdc: formatUsdc6(p.perCounterpartyDailyCap),
    rateLimit: `${p.rateLimit.maxPayments}/${p.rateLimit.windowMs / 1000}s`,
    allowlist: p.allowlist,
    denylist: p.denylist,
    allowedNetworks: p.allowedNetworks,
    requireVerifiedIdentity: p.requireVerifiedIdentity,
    requiredSellerBondUsdc: formatUsdc6(p.requiredSellerBond),
  };
}
