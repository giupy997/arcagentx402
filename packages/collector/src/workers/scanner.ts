import type { CollectorConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { Logger } from "../log.js";
import type { RuntimeState } from "../state.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Periodic integrity scan over the blocks table:
 *   - numeric holes between min(number) and max(number) -> block_gaps
 *   - parent_hash continuity (hash(N) == parent_hash(N+1)); a mismatch on a no-reorg chain means an
 *     RPC served bad data: we record it and re-ingest is a manual decision (never auto-delete).
 */
export class ScannerWorker {
  private stopped = false;
  private done: Promise<void> | null = null;
  constructor(
    private readonly cfg: CollectorConfig,
    private readonly db: Db,
    private readonly state: RuntimeState,
    private readonly log: Logger,
  ) {}

  start(): void {
    this.done = this.loop().catch((err) => this.log.error({ err }, "scanner crashed"));
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.done;
  }

  async scanOnce(): Promise<{ gaps: number; continuityErrors: number }> {
    const gaps = await this.db.query<{ from_block: string; to_block: string }>(
      `WITH s AS (SELECT number, lead(number) OVER (ORDER BY number) AS next FROM blocks)
       SELECT number + 1 AS from_block, next - 1 AS to_block FROM s WHERE next - number > 1`,
    );
    let inserted = 0;
    for (const g of gaps.rows) {
      // Do not report the still-open range above the head cursor / below the backfill cursor.
      const from = Number(g.from_block);
      const to = Number(g.to_block);
      const bf = this.state.backfill;
      if (bf && bf.active && to < bf.cursor) continue; // backfill will get there
      // History is off: the stretch between old blocks and the live range is a choice, not a hole.
      if (!this.cfg.backfillHistory && from < (this.state.headStart ?? this.cfg.startBlock)) continue;
      const r = await this.db.query("INSERT INTO block_gaps (from_block, to_block, last_error) VALUES ($1, $2, 'scanner') ON CONFLICT DO NOTHING", [from, to]);
      inserted += r.rowCount ?? 0;
    }
    const cont = await this.db.query<{ number: string }>(
      `WITH s AS (SELECT number, hash, lead(number) OVER (ORDER BY number) AS next, lead(parent_hash) OVER (ORDER BY number) AS next_parent FROM blocks
                  WHERE number > GREATEST(0, (SELECT max(number) FROM blocks) - 200000))
       SELECT number FROM s WHERE next = number + 1 AND next_parent <> hash LIMIT 20`,
    );
    if (cont.rows.length > 0) {
      this.log.error({ blocks: cont.rows.map((r) => Number(r.number)) }, "PARENT HASH CONTINUITY BROKEN (bad RPC data?) — investigate, not auto-fixed");
    }
    const c = await this.db.query<{ n: string }>("SELECT count(*) AS n FROM block_gaps");
    this.state.gapsOpen = Number(c.rows[0]?.n ?? 0);
    return { gaps: inserted, continuityErrors: cont.rows.length };
  }

  private async loop(): Promise<void> {
    await sleep(30_000);
    while (!this.stopped) {
      try {
        const r = await this.scanOnce();
        this.log.info(r, "integrity scan");
      } catch (err) {
        this.log.error({ err }, "scan failed");
      }
      for (let t = 0; t < this.cfg.gapScanIntervalMs && !this.stopped; t += 1000) await sleep(1000);
    }
  }
}
