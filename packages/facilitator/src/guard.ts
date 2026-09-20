/**
 * What this facilitator agrees to settle.
 *
 * A facilitator pays the gas for every payment it settles. One that settles anything for anyone is
 * a free relayer for the whole internet, and a way to move money through someone else's key. This
 * one is private: it settles payments to the payout addresses it was told about, in the asset and
 * on the networks it was told about, inside an amount range, and refuses everything else before a
 * single RPC call is made.
 */
import { compareUsdc6, usdc6, type Usdc6 } from "@cra-agent/accounting";

export interface GuardRules {
  /** Lowercase addresses this facilitator settles for. Empty means nothing is allowed. */
  readonly payTo: ReadonlySet<string>;
  /** CAIP-2 network to the one asset (lowercase) accepted on it. */
  readonly assets: ReadonlyMap<string, string>;
  readonly minAmount: Usdc6;
  readonly maxAmount: Usdc6;
}

export interface GuardedRequirements {
  readonly scheme: string;
  readonly network: string;
  readonly asset: string;
  readonly payTo: string;
  readonly amount: string;
}

/** null when the payment may go ahead, otherwise the reason it may not. */
export function refuse(req: GuardedRequirements, rules: GuardRules): string | null {
  if (req.scheme !== "exact") return `scheme ${req.scheme} is not settled here`;
  const asset = rules.assets.get(req.network);
  if (!asset) return `network ${req.network} is not settled here`;
  if (req.asset.toLowerCase() !== asset) return `asset ${req.asset} is not settled on ${req.network}`;
  if (!rules.payTo.has(req.payTo.toLowerCase())) return `this facilitator does not settle for ${req.payTo}`;
  if (!/^\d{1,30}$/.test(req.amount)) return "amount is not a whole number of base units";
  const amount = usdc6(BigInt(req.amount));
  if (compareUsdc6(amount, rules.minAmount) < 0) return `amount ${req.amount} is below the minimum ${rules.minAmount}`;
  if (compareUsdc6(amount, rules.maxAmount) > 0) return `amount ${req.amount} is above the maximum ${rules.maxAmount}`;
  return null;
}
