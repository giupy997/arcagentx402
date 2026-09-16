/**
 * A running reference price per pair, used to throw out legs that were parsed as a swap but priced
 * nothing a trader could have got. Structure alone cannot catch every one of them: a transaction
 * that touches two pools unevenly still nets to something that looks like a trade.
 *
 * The reference is the median of the last accepted rates, so one bad rate cannot drag it, and it
 * follows a market that moves. A pair says how far from it a rate may sit.
 */
const medianOf = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? null);
};

export class ReferencePrice {
  private readonly rates: number[] = [];
  /** The first rates of a cold start, held back until they say what the price is. */
  private booting: number[] = [];
  /** Rejected rates, kept in case the market has moved and it is the reference that is wrong. */
  private pending: number[] = [];

  constructor(
    private readonly maxDeviation: number,
    private readonly window = 25,
    /** How many rates it takes to fix a price, cold or after a move. */
    private readonly warmup = 8,
  ) {}

  /** Seed from rates already stored, newest first. There is then no cold start. */
  seed(rates: readonly number[]): void {
    for (const r of [...rates].reverse()) this.push(r);
  }

  get median(): number | null {
    return medianOf(this.rates);
  }

  /**
   * Accepts the rate and remembers it, or rejects it as too far from the running price.
   *
   * Cold, it judges nothing until enough rates agree on a price: those first rates are not used,
   * which costs a handful of trades once and keeps a mispriced leg from setting the reference.
   *
   * A price can also move faster than the reference follows, and then every trade looks wrong and
   * the reference would stay where it was for good. So rejected rates are kept: once enough of them
   * agree with each other, the market has moved and they become the new reference. Scattered
   * nonsense never agrees with itself, so it never takes over.
   */
  accept(rate: number): boolean {
    if (!Number.isFinite(rate) || rate <= 0) return false;
    if (this.rates.length === 0) return this.boot(rate);
    const m = this.median;
    if (m !== null && m > 0 && Math.abs(rate / m - 1) <= this.maxDeviation) {
      this.pending = [];
      this.push(rate);
      return true;
    }
    this.pending.push(rate);
    if (this.pending.length < this.warmup) return false;
    if (!this.agree(this.pending)) {
      this.pending.shift(); // they disagree: bad legs, not a move
      return false;
    }
    this.rates.length = 0;
    for (const r of this.pending) this.push(r);
    this.pending = [];
    return true;
  }

  private boot(rate: number): boolean {
    this.booting.push(rate);
    if (this.booting.length < this.warmup) return false;
    const m = medianOf(this.booting)!;
    for (const r of this.booting) if (Math.abs(r / m - 1) <= this.maxDeviation) this.push(r);
    this.booting = this.rates.length > 0 ? [] : this.booting.slice(1);
    return false; // the rates that fixed the price are not published as trades
  }

  private agree(rates: readonly number[]): boolean {
    const lo = Math.min(...rates);
    const hi = Math.max(...rates);
    return hi / lo - 1 <= this.maxDeviation * 3;
  }

  private push(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) return;
    this.rates.push(rate);
    if (this.rates.length > this.window) this.rates.shift();
  }
}
