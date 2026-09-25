/**
 * Amounts for `exact` on `lnbtc`: whole millisatoshis on the wire, decimal strings. Parsing is exact
 * decimal arithmetic. A bare number is not satoshis: the spec wants an explicit atomic amount or a
 * qualified "21 sat", and anything priced in dollars goes through a stated BTC/USD rate.
 */

function decimal(s: string, what: string): { digits: bigint; scale: number } {
  const m = /^([0-9]+)(?:\.([0-9]+))?$/.exec(s);
  if (!m) throw new Error(`${what} must be a non-negative decimal, got "${s}"`);
  const frac = m[2] ?? "";
  return { digits: BigInt(`${m[1]}${frac}`), scale: frac.length };
}

/** An explicit atomic amount ({ asset: "BTC", amount: "21000" }) or "21 sat(s)", as millisatoshis. */
export function lnbtcAmount(input: unknown): string {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const { asset, amount } = input as { asset?: unknown; amount?: unknown };
    if (asset !== "BTC" || typeof amount !== "string" || !/^[1-9][0-9]*$/.test(amount)) throw new Error('an lnbtc amount is { asset: "BTC", amount: "<millisatoshis>" }');
    return amount;
  }
  if (typeof input === "string") {
    const m = /^([0-9]+(?:\.[0-9]+)?) ?sats?$/.exec(input.trim());
    if (m) {
      const { digits, scale } = decimal(m[1]!, "sats");
      const msat = digits * 1000n;
      const den = 10n ** BigInt(scale);
      if (msat % den !== 0n) throw new Error("finer than a millisatoshi");
      const out = msat / den;
      if (out <= 0n) throw new Error("an amount is positive");
      return out.toString();
    }
  }
  throw new Error('use an explicit amount, { asset: "BTC", amount: "21000" }, or "21 sat"; a bare number is not satoshis');
}

/**
 * A dollar price in millisatoshis at a BTC/USD rate, rounded up so the seller never receives less than its
 * price, and never below `minMsat`.
 */
export function usdToMsat(usd: string, btcUsd: string, minMsat = 1n): string {
  const p = decimal(usd, "price");
  const r = decimal(btcUsd, "BTC/USD");
  if (r.digits === 0n) throw new Error("BTC/USD must be positive");
  // msat = usd / btcUsd * 1e11 BTC-msat, with both decimals scaled to integers.
  const num = p.digits * 100_000_000_000n * 10n ** BigInt(r.scale);
  const den = r.digits * 10n ** BigInt(p.scale);
  const msat = (num + den - 1n) / den;
  return (msat < minMsat ? minMsat : msat).toString();
}
