/**
 * Reading token <-> USDC swaps out of receipts, for any token quoted in USDC.
 *
 * A swap is one transaction where two addresses exchange the two tokens. We take the executed
 * amounts, so the rate is what the market actually paid, not a quoted price. Multi-hop routes and
 * transactions touching both sides in a more complex way are skipped rather than guessed: a wrong
 * rate is worse than a missing one.
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
  /** Smallest USDC amount worth pricing, in raw units. Default $0.50. */
  readonly minUsdcUnits?: bigint;
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
  /** USDC per whole unit of the base token, as executed. */
  rate: number;
}

const addr = (topic: string): string => `0x${topic.slice(26)}`.toLowerCase();
const DEFAULT_MIN_USDC = 500_000n; // $0.50

interface Flow {
  /** The two addresses, in a fixed order, so both directions land in the same bucket. */
  a: string;
  b: string;
  /** Signed totals: positive means a sent to b. */
  base: bigint;
  usdc: bigint;
  firstBaseIndex: number;
  firstUsdcIndex: number;
}

/**
 * Returns the swap in this receipt's logs, or null when it is not a clean two-sided swap.
 *
 * Transfers are netted per pair of addresses before anything is priced. A single swap often shows
 * up as several transfers between the same two addresses (a token with a transfer tax splits the
 * amount, a router sends and takes back), and pricing one of those legs on its own reports a rate
 * that is wrong by the size of the fee.
 */
export function extractFxTrade(logs: readonly MinimalLog[], base: string, usdc: string, rules: PairRules): FxTrade | null {
  const flows = new Map<string, Flow>();
  const baseAddr = base.toLowerCase();
  const usdcAddr = usdc.toLowerCase();
  logs.forEach((l, index) => {
    if (l.topics[0] !== TRANSFER_TOPIC || l.topics.length < 3) return;
    const token = l.address.toLowerCase();
    if (token !== baseAddr && token !== usdcAddr) return;
    const from = addr(l.topics[1]!);
    const to = addr(l.topics[2]!);
    if (from === to) return;
    const value = BigInt(l.data === "0x" ? "0x0" : l.data);
    if (value === 0n) return;
    const [a, b] = from < to ? [from, to] : [to, from];
    const signed = from === a ? value : -value;
    const key = `${a}:${b}`;
    const f = flows.get(key) ?? { a: a!, b: b!, base: 0n, usdc: 0n, firstBaseIndex: -1, firstUsdcIndex: -1 };
    if (token === baseAddr) {
      f.base += signed;
      if (f.firstBaseIndex < 0) f.firstBaseIndex = index;
    } else {
      f.usdc += signed;
      if (f.firstUsdcIndex < 0) f.firstUsdcIndex = index;
    }
    flows.set(key, f);
  });

  const scale = 10 ** (rules.decimals - 6); // USDC has 6 decimals; price is per whole base unit
  const minUsdc = rules.minUsdcUnits ?? DEFAULT_MIN_USDC;
  let best: FxTrade | null = null;
  let bestUsdc = 0n;
  for (const f of flows.values()) {
    // A swap sends the two tokens in opposite directions between the same two addresses.
    if (f.base === 0n || f.usdc === 0n) continue;
    if (f.base > 0n === f.usdc > 0n) continue;
    const baseAmount = f.base < 0n ? -f.base : f.base;
    const usdcAmount = f.usdc < 0n ? -f.usdc : f.usdc;
    if (baseAmount < rules.minBaseUnits || usdcAmount < minUsdc) continue;
    const rate = (Number(usdcAmount) / Number(baseAmount)) * scale;
    if (!Number.isFinite(rate) || rate < rules.minPrice || rate > rules.maxPrice) continue;
    if (usdcAmount <= bestUsdc) continue; // when a route touches several pools, price the biggest leg
    // Who is the trader: the side that put the base token in is selling it, and the leg logged
    // first is the one paid in.
    const baseSender = f.base > 0n ? f.a : f.b;
    const baseReceiver = f.base > 0n ? f.b : f.a;
    const sell = f.firstBaseIndex < f.firstUsdcIndex;
    best = sell
      ? { direction: "sell", symbol: rules.symbol, trader: baseSender, venue: baseReceiver, baseAmount, usdcAmount, rate }
      : { direction: "buy", symbol: rules.symbol, trader: baseReceiver, venue: baseSender, baseAmount, usdcAmount, rate };
    bestUsdc = usdcAmount;
  }
  return best;
}
