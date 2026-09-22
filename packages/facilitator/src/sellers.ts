/**
 * The sellers this facilitator settles for, beyond the ones named at start.
 *
 * A seller registers by proving control of the wallet that gets paid (the API checks that
 * signature; this process only ever hears about addresses that passed). Every settlement costs
 * this facilitator gas, so each seller has a daily allowance; past it, the buyer is told to pay
 * through Gateway instead, which needs no gas of ours. The list survives a restart in a file; the
 * day's counts do not, which at worst costs a little extra gas after a restart.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SellerStatus {
  readonly registered: boolean;
  readonly settledToday: number;
  readonly dailyCap: number;
  readonly since: string | null;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

export class SellerRegistry {
  private readonly sellers = new Map<string, string>();
  private counts = new Map<string, number>();
  private countsDay: string;

  constructor(
    private readonly file: string | null,
    readonly dailyCap: number,
    private readonly now: () => number = Date.now,
  ) {
    this.countsDay = utcDay(now());
    if (file && existsSync(file)) {
      const doc = JSON.parse(readFileSync(file, "utf8")) as { sellers?: Record<string, string> };
      for (const [a, since] of Object.entries(doc.sellers ?? {})) if (ADDRESS.test(a)) this.sellers.set(a, since);
    }
  }

  /** Adds a seller. Returns false when the address is not one, true whether it was new or already there. */
  add(address: string): boolean {
    const a = address.toLowerCase();
    if (!ADDRESS.test(a)) return false;
    if (!this.sellers.has(a)) {
      this.sellers.set(a, new Date(this.now()).toISOString());
      this.persist();
    }
    return true;
  }

  has(address: string): boolean {
    return this.sellers.has(address.toLowerCase());
  }

  /** Why a settlement for this seller may not go ahead today, or null. */
  refuse(address: string): string | null {
    if (!this.has(address)) return null;
    if (this.settledToday(address) >= this.dailyCap) return `daily allowance of ${this.dailyCap} settlements reached for ${address}; it opens again tomorrow (UTC)`;
    return null;
  }

  settledToday(address: string): number {
    this.rollDay();
    return this.counts.get(address.toLowerCase()) ?? 0;
  }

  recordSettlement(address: string): void {
    this.rollDay();
    const a = address.toLowerCase();
    this.counts.set(a, (this.counts.get(a) ?? 0) + 1);
  }

  status(address: string): SellerStatus {
    const a = address.toLowerCase();
    return { registered: this.sellers.has(a), settledToday: this.settledToday(a), dailyCap: this.dailyCap, since: this.sellers.get(a) ?? null };
  }

  get size(): number {
    return this.sellers.size;
  }

  private rollDay(): void {
    const day = utcDay(this.now());
    if (day !== this.countsDay) {
      this.counts = new Map();
      this.countsDay = day;
    }
  }

  private persist(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sellers: Object.fromEntries(this.sellers) }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
