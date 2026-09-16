/**
 * Reading EURC <-> USDC swaps out of receipts.
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

/** EUR/USD has not left this band in modern history: anything outside it is not a EURC/USDC swap. */
export const MIN_RATE = 0.5;
export const MAX_RATE = 2;
/** Below one euro the amounts are dust or rounding, and they distort every average. */
export const MIN_EURC_UNITS = 1_000_000n; // 1.000000 EURC, 6 decimals

export interface FxTrade {
  side: "EURC->USDC" | "USDC->EURC";
  trader: string;
  venue: string | null;
  eurcAmount: bigint;
  usdcAmount: bigint;
  /** USDC per EURC. */
  rate: number;
}

const addr = (topic: string): string => `0x${topic.slice(26)}`.toLowerCase();

/** Returns the swap in this receipt's logs, or null when it is not a clean two-sided swap. */
export function extractFxTrade(logs: readonly MinimalLog[], eurc: string, usdc: string): FxTrade | null {
  type Move = { from: string; to: string; value: bigint; index: number };
  const eurcMoves: Move[] = [];
  const usdcMoves: Move[] = [];
  logs.forEach((l, index) => {
    if (l.topics[0] !== TRANSFER_TOPIC || l.topics.length < 3) return;
    const move = { from: addr(l.topics[1]!), to: addr(l.topics[2]!), value: BigInt(l.data === "0x" ? "0x0" : l.data), index };
    const a = l.address.toLowerCase();
    if (a === eurc.toLowerCase()) eurcMoves.push(move);
    else if (a === usdc.toLowerCase()) usdcMoves.push(move);
  });
  if (eurcMoves.length === 0 || usdcMoves.length === 0) return null;

  for (const e of eurcMoves) {
    for (const u of usdcMoves) {
      if (e.value < MIN_EURC_UNITS || u.value === 0n) continue;
      // A swap moves both tokens between the SAME two addresses. Requiring both legs keeps out
      // transactions where the two stablecoins move for unrelated reasons, which is common on a
      // router that also handles other tokens.
      const sellsEurc = e.from === u.to && e.to === u.from && e.from !== e.to;
      const sellsUsdc = u.from === e.to && u.to === e.from && u.from !== u.to;
      if (!sellsEurc && !sellsUsdc) continue;
      const rate = Number(u.value) / Number(e.value);
      if (!Number.isFinite(rate) || rate < MIN_RATE || rate > MAX_RATE) continue;
      // Both can hold at once: the trader and the venue each appear on both legs.
      // The leg logged first is the one paid in, which settles the direction.
      const eurcIn = e.index < u.index;
      return eurcIn
        ? { side: "EURC->USDC", trader: e.from, venue: e.to, eurcAmount: e.value, usdcAmount: u.value, rate }
        : { side: "USDC->EURC", trader: u.from, venue: u.to, eurcAmount: e.value, usdcAmount: u.value, rate };
    }
  }
  return null;
}
