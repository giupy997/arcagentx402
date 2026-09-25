/**
 * The BTC/USD rate a Lightning price is worked out at: the median of public exchange tickers, refused when
 * fewer than two answer or when they disagree, so a price in sats is never set by one bad quote.
 */

export interface RateSource {
  readonly name: string;
  read(fetchImpl: typeof fetch): Promise<string>;
}

const json = async (fetchImpl: typeof fetch, url: string): Promise<unknown> => {
  const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
};

export const RATE_SOURCES: readonly RateSource[] = [
  { name: "coinbase", read: async (f) => String(((await json(f, "https://api.coinbase.com/v2/prices/BTC-USD/spot")) as { data: { amount: string } }).data.amount) },
  {
    name: "kraken",
    read: async (f) => {
      const r = ((await json(f, "https://api.kraken.com/0/public/Ticker?pair=XBTUSD")) as { result: Record<string, { c: [string, string] }> }).result;
      return String(Object.values(r)[0]!.c[0]);
    },
  },
  { name: "bitstamp", read: async (f) => String(((await json(f, "https://www.bitstamp.net/api/v2/ticker/btcusd/")) as { last: string }).last) },
];

export interface BtcUsd {
  /** Dollars per bitcoin, as a decimal string. */
  readonly rate: string;
  readonly sources: Record<string, string>;
  readonly at: number;
}

/** A rate that is read at most once a minute; refused when fewer than two sources agree within `spread`. */
export function btcUsdRate(o: { fetchImpl?: typeof fetch; sources?: readonly RateSource[]; maxAgeMs?: number; spread?: number; now?: () => number } = {}) {
  const sources = o.sources ?? RATE_SOURCES;
  const maxAge = o.maxAgeMs ?? 60_000;
  const spread = o.spread ?? 0.02;
  const now = o.now ?? Date.now;
  let last: BtcUsd | null = null;
  let pending: Promise<BtcUsd> | null = null;
  const read = async (): Promise<BtcUsd> => {
    const got = await Promise.allSettled(sources.map(async (s) => [s.name, await s.read(o.fetchImpl ?? fetch)] as const));
    const ok = got.flatMap((g) => (g.status === "fulfilled" && /^[0-9]+(\.[0-9]+)?$/.test(g.value[1]) && Number(g.value[1]) > 0 ? [g.value] : []));
    if (ok.length < 2) throw new Error(`BTC/USD: only ${ok.length} source answered`);
    const values = ok.map(([, v]) => Number(v)).sort((a, b) => a - b);
    const median = values.length % 2 ? values[(values.length - 1) / 2]! : (values[values.length / 2 - 1]! + values[values.length / 2]!) / 2;
    if ((values.at(-1)! - values[0]!) / median > spread) throw new Error(`BTC/USD: sources disagree (${values.join(", ")})`);
    return { rate: median.toFixed(2), sources: Object.fromEntries(ok), at: now() };
  };
  return async (): Promise<BtcUsd> => {
    if (last && now() - last.at < maxAge) return last;
    pending ??= read().finally(() => (pending = null));
    last = await pending;
    return last;
  };
}
