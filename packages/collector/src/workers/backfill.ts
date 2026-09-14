import type { CollectorConfig } from "../config.js";
import { getState, setState, type Db } from "../db/index.js";
import { fetchBlocks } from "../ingest/fetch.js";
import { writeBundle } from "../ingest/write.js";
import type { Logger } from "../log.js";
import type { RpcPool } from "../rpc/pool.js";
import type { RuntimeState } from "../state.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Backfill + gap filler. Two queues:
 *   1. block_gaps rows (holes left by the head worker or found by the scanner) — highest priority;
 *   2. the historical range [0, headStart-1] if the collector started above genesis — ascending.
 * Runs at low concurrency and pauses while the head worker is behind, so live data wins.
 */
export class BackfillWorker {
  private stopped = false;
  private done: Promise<void> | null = null;

  constructor(
    private readonly cfg: CollectorConfig,
    private readonly db: Db,
    private readonly pool: RpcPool,
    private readonly state: RuntimeState,
    private readonly log: Logger,
  ) {}

  async init(): Promise<void> {
    const saved = await getState<{ cursor: number; target: number }>(this.db, "backfill");
    if (saved) {
      this.state.backfill = { ...saved, active: saved.cursor <= saved.target };
      return;
    }
    const start = this.state.headStart ?? this.cfg.startBlock;
    if (start > 0 && this.cfg.backfillHistory) {
      this.state.backfill = { cursor: 0, target: start - 1, active: true };
      await setState(this.db, "backfill", { cursor: 0, target: start - 1 });
      this.log.warn({ target: start - 1 }, "collector did not start at genesis: historical backfill scheduled from block 0");
    } else {
      if (start > 0) this.log.warn({ start }, "COLLECTOR_BACKFILL_HISTORY=0: blocks below the start block will NOT be collected");
      this.state.backfill = { cursor: 0, target: -1, active: false };
    }
  }

  start(): void {
    this.done = this.loop().catch((err) => this.log.error({ err }, "backfill worker crashed"));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.done;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const lag = this.state.lag();
        if (lag !== null && lag > this.cfg.lagAlertBlocks) {
          await sleep(2000); // live ingestion is struggling: leave the RPCs alone
          continue;
        }
        const didGap = await this.fillOneGap();
        if (didGap) continue;
        const didHist = await this.backfillChunk();
        if (!didHist) await sleep(5000);
      } catch (err) {
        this.log.error({ err }, "backfill loop error");
        await sleep(2000);
      }
    }
  }

  private async fillOneGap(): Promise<boolean> {
    const r = await this.db.query<{ from_block: string; to_block: string; attempts: number }>(
      "SELECT from_block, to_block, attempts FROM block_gaps ORDER BY attempts ASC, from_block ASC LIMIT 1",
    );
    const gap = r.rows[0];
    if (!gap) {
      this.state.gapsOpen = 0;
      return false;
    }
    const from = Number(gap.from_block);
    const to = Number(gap.to_block);
    const chunkEnd = Math.min(to, from + this.cfg.batchBlocks - 1);
    const numbers = Array.from({ length: chunkEnd - from + 1 }, (_, i) => from + i);
    const failed = await this.ingest(numbers);
    if (failed.length === 0) {
      if (chunkEnd === to) await this.db.query("DELETE FROM block_gaps WHERE from_block = $1", [from]);
      else await this.db.query("UPDATE block_gaps SET from_block = $2 WHERE from_block = $1", [from, chunkEnd + 1]); // shrink
      this.log.info({ from, to: chunkEnd }, "gap filled");
    } else {
      await this.db.query("UPDATE block_gaps SET attempts = attempts + 1, last_error = $2 WHERE from_block = $1", [from, `still failing: ${failed.join(",")}`]);
      await sleep(Math.min(30_000, 1000 * 2 ** Math.min(gap.attempts, 5)));
    }
    const c = await this.db.query<{ n: string }>("SELECT count(*) AS n FROM block_gaps");
    this.state.gapsOpen = Number(c.rows[0]?.n ?? 0);
    return true;
  }

  private async backfillChunk(): Promise<boolean> {
    const bf = this.state.backfill;
    if (!bf || !bf.active) return false;
    if (bf.cursor > bf.target) {
      bf.active = false;
      this.log.info("historical backfill complete");
      return false;
    }
    const chunks: number[][] = [];
    let n = bf.cursor;
    for (let c = 0; c < this.cfg.backfillConcurrency && n <= bf.target; c++) {
      const end = Math.min(n + this.cfg.batchBlocks - 1, bf.target);
      chunks.push(Array.from({ length: end - n + 1 }, (_, i) => n + i));
      n = end + 1;
    }
    const failedAll = (await Promise.all(chunks.map((c) => this.ingest(c)))).flat();
    for (const f of failedAll) {
      await this.db.query("INSERT INTO block_gaps (from_block, to_block, last_error) VALUES ($1, $1, 'backfill') ON CONFLICT DO NOTHING", [f]);
    }
    bf.cursor = n;
    await setState(this.db, "backfill", { cursor: bf.cursor, target: bf.target });
    return true;
  }

  /** Returns numbers that failed. Blocks fetched here are never "observed live". */
  private async ingest(numbers: number[]): Promise<number[]> {
    let pending = numbers;
    for (let attempt = 0; attempt < 3 && pending.length > 0; attempt++) {
      let res;
      try {
        res = await fetchBlocks(this.pool, pending);
      } catch (err) {
        this.log.warn({ err, first: pending[0] }, "backfill fetch failed");
        await sleep(500 * (attempt + 1));
        continue;
      }
      for (const fb of res.ok) {
        const r = await writeBundle(this.db, fb.bundle, {
          sourceRpc: this.pool.endpoints.find((e) => e.url === fb.endpoint)?.name ?? fb.endpoint,
          fetchMs: fb.fetchMs,
          observedAt: null,
          observedVia: null,
        });
        if (r.inserted) {
          this.state.blocksIngested++;
          this.state.txsIngested += fb.bundle.txs.length;
        }
      }
      pending = res.failed.map((f) => f.number);
    }
    return pending;
  }
}
