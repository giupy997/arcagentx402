/**
 * The replay store for `exact` on `lnbtc` in Postgres (migration 015): a unique key claimed with one
 * INSERT, so two settlements of the same proof race to the same row and exactly one wins, on any instance
 * that shares the database. Expired rows are removed only well after they could matter.
 */
import type { ReplayStore } from "./lnbtc.js";

/** The part of a pg Pool this needs. */
export interface Queryable {
  query(sql: string, values?: unknown[]): Promise<{ rowCount: number | null }>;
}

export class PgReplayStore implements ReplayStore {
  constructor(private readonly db: Queryable) {}

  async claim(key: string, keepUntilUnix: number): Promise<boolean> {
    const r = await this.db.query("INSERT INTO lnbtc_settlements (key, keep_until) VALUES ($1, to_timestamp($2)) ON CONFLICT (key) DO NOTHING", [key, keepUntilUnix]);
    return r.rowCount === 1;
  }

  /** Removes rows a day past their keep-until time; returns how many. */
  async prune(): Promise<number> {
    const r = await this.db.query("DELETE FROM lnbtc_settlements WHERE keep_until < now() - interval '1 day'");
    return r.rowCount ?? 0;
  }
}
