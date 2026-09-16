/**
 * Reading token <-> USDC swaps out of receipts, for any token quoted in USDC.
 *
 * A swap is one transaction where the same address sends one stablecoin and receives the other.
 * We take the executed amounts, so the rate is what the market actually paid, not a quoted price.
 * Multi-hop routes and transactions touching both sides in a more complex way are skipped rather
 * than guessed: a wrong rate is worse than a missing one.
 */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface MinimalLog {
  address: string;
  topics: string[];
  data: string;
}

/** Per-pair sanity band and dust floor: a stablecoin pair is tight, a volatile token is not. */
export interface PairRules {
  readonly symbol: string;
  readonly token: string;
  readonly decimals: number;
  /** Plausible price range in USDC. Outside it, the transaction is not a swap of this pair. */
  readonly minPrice: number;
  readonly maxPrice: number;
  /** Smallest base amount worth pricing, in raw units. */
  readonly minBaseUnits: bigint;
}

/** EUR/USD has not left this band in modern history. */
export const EURC_RULES: PairRules = { symbol: "EURC", token: "", decimals: 6, minPrice: 0.5, maxPrice: 2, minBaseUnits: 1_000_000n };

export interface FxTrade {
  /** sell: the trader gave the base token and took USDC. buy: the other way round. */
  direction: "sell" | "buy";
  symbol: string;
  trader: string;
  venue: string | null;
  baseAmount: bigint;
  usdcAmount: bigint;
  /** USDC per unit of the base token, as executed. */
  rate: number;
}

const addr = (topic: string): string => `0x${topic.slice(26)}`.toLowerCase();

/** Returns the swap in this receipt's logs, or null when it is not a clean two-sided swap. */
export function extractFxTrade(logs: readonly MinimalLog[], base: string, usdc: string, rules: PairRules): FxTrade | null {
  type Move = { from: string; to: string; value: bigint; index: number };
  const baseMoves: Move[] = [];
  const usdcMoves: Move[] = [];
  logs.forEach((l, index) => {
    if (l.topics[0] !== TRANSFER_TOPIC || l.topics.length < 3) return;
    const move = { from: addr(l.topics[1]!), to: addr(l.topics[2]!), value: BigInt(l.data === "0x" ? "0x0" : l.data), index };
    const a = l.address.toLowerCase();
    if (a === base.toLowerCase()) baseMoves.push(move);
    else if (a === usdc.toLowerCase()) usdcMoves.push(move);
  });
  if (baseMoves.length === 0 || usdcMoves.length === 0) return null;

  const scale = 10 ** (rules.decimals - 6); // USDC has 6 decimals; price is per whole base unit

  for (const b of baseMoves) {
    for (const u of usdcMoves) {
      if (b.value < rules.minBaseUnits || u.value === 0n) continue;
      // A swap moves both tokens between the SAME two addresses. Requiring both legs keeps out
      // transactions where the two tokens move for unrelated reasons, which is common on a
      // router that also handles other tokens.
      const sellsBase = b.from === u.to && b.to === u.from && b.from !== b.to;
      const sellsUsdc = u.from === b.to && u.to === b.from && u.from !== u.to;
      if (!sellsBase && !sellsUsdc) continue;
      const rate = (Number(u.value) / Number(b.value)) * scale;
      if (!Number.isFinite(rate) || rate < rules.minPrice || rate > rules.maxPrice) continue;
      // Both can hold at once: the trader and the venue each appear on both legs.
      // The leg logged first is the one paid in, which settles the direction.
      const baseIn = b.index < u.index;
      return baseIn
        ? { direction: "sell", symbol: rules.symbol, trader: b.from, venue: b.to, baseAmount: b.value, usdcAmount: u.value, rate }
        : { direction: "buy", symbol: rules.symbol, trader: u.from, venue: u.to, baseAmount: b.value, usdcAmount: u.value, rate };
    }
  }
  return null;
}
