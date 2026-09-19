import type { Alerter } from "../alerts.js";
import type { CollectorConfig } from "../config.js";
import { getState, setState, type Db } from "../db/index.js";
import { fetchBlocks, type FetchedBlock } from "../ingest/fetch.js";
import { writeBundle } from "../ingest/write.js";
import type { Logger } from "../log.js";
import type { RpcPool } from "../rpc/pool.js";
import type { RpcBlock } from "../rpc/types.js";
import type { RuntimeState } from "../state.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LIVE_WINDOW = 3; // blocks within this distance of the head at fetch time count as "observed live"
const MAX_INLINE_RETRIES = 4;

/**
 * Head follower: keeps `headCursor` contiguous from its start block up to the chain head.
 * Blocks that still fail after inline retries are recorded in block_gaps so the head never stalls;
 * the gap worker fills them later. No reorg handling: Arc finality is deterministic on inclusion.
 */
export class HeadWorker {
  private stopped = false;
  private done: Promise<void> | null = null;

  constructor(
    private readonly cfg: CollectorConfig,
    private readonly db: Db,
    private readonly pool: RpcPool,
    private readonly state: RuntimeState,
    private readonly alerts: Alerter,
    private readonly log: Logger,
  ) {}

  async init(): Promise<void> {
    const saved = await getState<{ cursor: number; start: number }>(this.db, "head");
    if (saved) {
      this.state.headCursor = saved.cursor;
      this.state.headStart = saved.start;
      this.log.info({ cursor: saved.cursor, start: saved.start }, "head cursor restored");
      return;
    }
    // Fresh DB (or old state lost): resume from the highest block we have, else the configured start.
    const r = await this.db.query<{ max: string | null }>("SELECT max(number) AS max FROM blocks");
    const max = r.rows[0]?.max === null || r.rows[0]?.max === undefined ? null : Number(r.rows[0].max);
    const start = max !== null ? max + 1 : this.cfg.startBlock;
    this.state.headStart = start;
    this.state.headCursor = start - 1;
    await setState(this.db, "head", { cursor: start - 1, start });
    this.log.info({ start }, "head cursor initialised");
  }

  start(): void {
    this.done = this.loop().catch((err) => {
      this.log.fatal({ err }, "head worker crashed");
      process.exitCode = 1;
      process.kill(process.pid, "SIGTERM");
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.done;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const head = await this.pollHead();
        const cursor = this.state.headCursor!;
        if (head <= cursor) {
          await sleep(this.cfg.headPollMs);
          continue;
        }
        if (this.cfg.maxCatchupBlocks > 0 && head - cursor > this.cfg.maxCatchupBlocks) {
          await this.jumpToHead(cursor, head);
          continue;
        }
        await this.catchUp(cursor + 1, head);
      } catch (err) {
        this.state.errors++;
        this.log.error({ err }, "head loop error");
        await sleep(1000);
      }
    }
  }

  /**
   * Too far behind to be useful live: what people look at is the last hour, and walking there block
   * by block would keep every page stale for hours. The missed range becomes a gap, filled in the
   * background, newest first.
   */
  private async jumpToHead(cursor: number, head: number): Promise<void> {
    const resumeAt = head - 50; // a short run-up, so the first live blocks have a parent in the table
    await this.db.query(
      "INSERT INTO block_gaps (from_block, to_block, last_error) VALUES ($1, $2, 'jumped to head') ON CONFLICT (from_block) DO UPDATE SET to_block = GREATEST(block_gaps.to_block, EXCLUDED.to_block)",
      [cursor + 1, resumeAt - 1],
    );
    this.state.headCursor = resumeAt - 1;
    await setState(this.db, "head", { cursor: resumeAt - 1, start: this.state.headStart ?? resumeAt });
    this.log.warn({ from: cursor + 1, to: resumeAt - 1, blocks: resumeAt - 1 - cursor }, "too far behind: jumped to the head, the missed range is now a gap");
  }

  /** Cheap head poll on the preferred endpoint; the full multi-endpoint probe lives in probe.ts. */
  private async pollHead(): Promise<number> {
    const r = await this.pool.call<RpcBlock>("eth_getBlockByNumber", ["latest", false]);
    if (!r.outcome.ok || !r.outcome.result) throw new Error(`latest block unavailable: ${!r.outcome.ok ? r.outcome.error.message : "null"}`);
    const n = Number(BigInt(r.outcome.result.number));
    this.pool.recordHead(r.endpoint, n);
    if (this.state.chainHead === null || n > this.state.chainHead) {
      this.state.chainHead = n;
      this.state.chainHeadAt = Date.now();
    }
    return this.state.chainHead!;
  }

  /** Ingest [from, to] in order of batches, with bounded concurrency. Advances cursor contiguously. */
  private async catchUp(from: number, to: number): Promise<void> {
    const { batchBlocks, concurrency } = this.cfg;
    let next = from;
    while (next <= to && !this.stopped) {
      // Refresh head while catching up so the "observed live" flag is accurate.
      const headNow = next + batchBlocks * concurrency > to ? await this.pollHead() : this.state.chainHead!;
      const batches: number[][] = [];
      for (let c = 0; c < concurrency && next <= Math.max(to, headNow); c++) {
        const end = Math.min(next + batchBlocks - 1, Math.max(to, headNow));
        batches.push(Array.from({ length: end - next + 1 }, (_, i) => next + i));
        next = end + 1;
      }
      const results = await Promise.all(batches.map((nums) => this.ingestNumbers(nums, headNow)));
      const lastCommitted = batches[batches.length - 1]![batches[batches.length - 1]!.length - 1]!;
      const gapRanges = results.flat();
      if (gapRanges.length > 0) {
        for (const n of gapRanges) {
          await this.db.query("INSERT INTO block_gaps (from_block, to_block, last_error) VALUES ($1, $1, $2) ON CONFLICT (from_block) DO NOTHING", [n, "head worker gave up after inline retries"]);
        }
        this.log.warn({ count: gapRanges.length, first: gapRanges[0] }, "blocks handed over to gap worker");
        this.state.gapsOpen += gapRanges.length;
      }
      this.state.headCursor = lastCommitted;
      await setState(this.db, "head", { cursor: lastCommitted, start: this.state.headStart });
      to = Math.max(to, headNow);
    }
  }

  /** Returns the block numbers that could NOT be ingested. */
  private async ingestNumbers(numbers: number[], headAtFetch: number): Promise<number[]> {
    let pending = numbers;
    const exclude = new Set<string>();
    for (let attempt = 0; attempt <= MAX_INLINE_RETRIES && pending.length > 0; attempt++) {
      let res;
      try {
        res = await fetchBlocks(this.pool, pending, exclude.size > 0 && exclude.size < this.pool.endpoints.length ? exclude : undefined, this.cfg.rawMode);
      } catch (err) {
        this.log.warn({ err, attempt, first: pending[0] }, "fetch batch failed");
        await sleep(300 * (attempt + 1));
        continue;
      }
      await this.writeAll(res.ok, headAtFetch);
      if (res.failed.length > 0) {
        // "not available yet" on a lagging node: try another endpoint next round.
        for (const f of res.failed) if (f.endpoint) exclude.add(f.endpoint);
        this.log.debug({ failed: res.failed.slice(0, 3), attempt }, "partial batch failure");
        await sleep(150 * (attempt + 1));
      }
      pending = res.failed.map((f) => f.number);
    }
    return pending;
  }

  private async writeAll(blocks: FetchedBlock[], headAtFetch: number): Promise<void> {
    for (const fb of blocks) {
      const live = headAtFetch - fb.number <= LIVE_WINDOW;
      const r = await writeBundle(this.db, fb.bundle, {
        mode: this.cfg.mode,
        sourceRpc: this.pool.endpoints.find((e) => e.url === fb.endpoint)?.name ?? fb.endpoint,
        fetchMs: fb.fetchMs,
        observedAt: live ? new Date() : null,
        observedVia: live ? "head" : null,
      });
      if (r.inserted) {
        this.state.blocksIngested++;
        this.state.txsIngested += fb.bundle.txs.length;
        this.state.lastIngestAt = Date.now();
        if (fb.bundle.deploys.length > 0) this.log.info({ block: fb.number, deploys: fb.bundle.deploys.length }, "contract deploy(s)");
      }
    }
  }
}
