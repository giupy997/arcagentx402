/**
 * A running reference price per pair, used to throw out legs that were parsed as a swap but priced
 * nothing a trader could have got. Structure alone cannot catch every one of them: a transaction
 * that touches two pools unevenly still nets to something that looks like a trade.
 *
 * The reference is the median of the last accepted rates, so one bad rate cannot drag it, and it
 * follows a market that moves. A pair says how far from it a rate may sit.
 */
export class ReferencePrice {
  private readonly rates: number[] = [];

  constructor(
    private readonly maxDeviation: number,
    private readonly window = 25,
    /** Rates accepted before the guard turns on, so a new pair can start from nothing. */
    private readonly warmup = 8,
  ) {}

  /** Seed from rates already stored, newest first. */
  seed(rates: readonly number[]): void {
    for (const r of [...rates].reverse()) this.push(r);
  }

  get median(): number | null {
    if (this.rates.length < this.warmup) return null;
    const sorted = [...this.rates].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? null);
  }

  /** Accepts the rate and remembers it, or rejects it as too far from the running price. */
  accept(rate: number): boolean {
    const m = this.median;
    if (m !== null && m > 0 && Math.abs(rate / m - 1) > this.maxDeviation) return false;
    this.push(rate);
    return true;
  }

  private push(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) return;
    this.rates.push(rate);
    if (this.rates.length > this.window) this.rates.shift();
  }
}
