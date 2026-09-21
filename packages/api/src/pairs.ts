/**
 * The pairs the collector prices against USDC, as the API names them. The symbol stored with each
 * trade is the token's own (cirBTC, not BTC), and a caller may ask in any case or by the plain name.
 */
export interface Pair {
  /** As stored by the collector. */
  readonly symbol: string;
  /** Decimals of the base token: they decide how an amount is scaled. */
  readonly decimals: number;
}

const project = process.env.TOKEN_SYMBOL ?? "CRA";
export const PAIRS: readonly Pair[] = [
  { symbol: "EURC", decimals: 6 },
  { symbol: "cirBTC", decimals: 8 },
  { symbol: "WETH", decimals: 18 },
  { symbol: project, decimals: 18 },
];
const ALIASES: Record<string, string> = { BTC: "cirBTC", BITCOIN: "cirBTC", ETH: "WETH", ETHER: "WETH", EUR: "EURC" };

/** The pair a query names, or EURC when it names none. Null when we do not price it. */
export function resolvePair(q: string | undefined): Pair | null {
  const asked = (q ?? "EURC").trim().toUpperCase();
  const wanted = (ALIASES[asked] ?? asked).toUpperCase();
  return PAIRS.find((p) => p.symbol.toUpperCase() === wanted) ?? null;
}
