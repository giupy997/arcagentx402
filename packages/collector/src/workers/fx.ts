/**
 * FX watcher: records every EURC <-> USDC swap on Arc with the rate it executed at.
 * Cheap by design: scan EURC transfer logs (few per block), then only fetch the receipts of those
 * transactions to see the USDC side. USDC alone moves hundreds of thousands of times a day.
 */
import type { CollectorConfig } from "../config.js";
import { getState, hexToBytes, setState, type Db } from "../db/index.js";
import { extractFxTrade, TRANSFER_TOPIC, type MinimalLog } from "../ingest/fx.js";
import type { Logger } from "../log.js";
import type { RpcPool } from "../rpc/pool.js";
import type { RuntimeState } from "../state.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RawLog extends MinimalLog { blockNumber: string; transactionHash: string; blockTimestamp?: string }
interface RawReceipt { transactionHash: string; blockNumber: string; logs: RawLog[] }

export class FxWorker {
  private stopped = false;
  private done: Promise<void> | null = null;

  constructor(
    private readonly cfg: CollectorConfig,
    private readonly db: Db,
    private readonly pool: RpcPool,
    private readonly state: RuntimeState,
    private readonly log: Logger,
  ) {}

  start(): void {
    this.done = this.loop().catch((err) => this.log.error({ err }, "fx watcher crashed"));
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.done;
  }

  private async loop(): Promise<void> {
    const fx = this.cfg.fx;
    if (!fx) return;
    let cursor = (await getState<{ cursor: number }>(this.db, "fx"))?.cursor ?? 0;
    if (cursor === 0) cursor = (this.state.chainHead ?? 0) - 20_000; // start from roughly the last three hours
    this.log.info({ eurc: fx.eurc, from: cursor }, "fx watcher started");
    while (!this.stopped) {
      try {
        const head = this.state.chainHead;
        if (head === null || cursor > head) {
          await sleep(6000);
          continue;
        }
        const to = Math.min(head, cursor + 1999);
        const logs = await this.pool.callResult<RawLog[]>(
          "eth_getLogs",
          [{ address: fx.eurc, topics: [TRANSFER_TOPIC], fromBlock: `0x${cursor.toString(16)}`, toBlock: `0x${to.toString(16)}` }],
          { maxAttempts: 3, quiet: true },
        );
        const txs = [...new Set((logs ?? []).map((l) => l.transactionHash))];
        if (txs.length > 0) await this.recordSwaps(txs, fx);
        cursor = to + 1;
        await setState(this.db, "fx", { cursor });
        if (to === head) await sleep(10_000);
      } catch (err) {
        this.log.warn({ err: (err as Error).message }, "fx watcher retry");
        await sleep(6000);
      }
    }
  }

  private async recordSwaps(txHashes: string[], fx: { eurc: string; usdc: string }): Promise<void> {
    const rows: { hash: string; block: number; ts: number; trade: ReturnType<typeof extractFxTrade> }[] = [];
    for (let i = 0; i < txHashes.length; i += 20) {
      const chunk = txHashes.slice(i, i + 20);
      const routed = await this.pool.batch<RawReceipt | null>(chunk.map((h) => ({ method: "eth_getTransactionReceipt", params: [h] })), { quiet: true });
      for (const outcome of routed.outcomes) {
        if (!outcome.ok || !outcome.result) continue;
        const r = outcome.result;
        const trade = extractFxTrade(r.logs ?? [], fx.eurc, fx.usdc);
        if (!trade) continue;
        const block = Number(BigInt(r.blockNumber));
        const tsLog = (r.logs ?? []).find((l) => l.blockTimestamp)?.blockTimestamp;
        let ts = tsLog ? Number(BigInt(tsLog)) : 0;
        if (!ts) {
          const q = await this.db.query<{ t: string }>('SELECT "timestamp" AS t FROM blocks WHERE number = $1', [block]);
          ts = q.rows[0] ? Number(q.rows[0].t) : Math.floor(Date.now() / 1000);
        }
        rows.push({ hash: r.transactionHash, block, ts, trade });
      }
    }
    if (rows.length === 0) return;
    await this.db.query(
      `INSERT INTO fx_trades (tx_hash, block_number, "timestamp", side, trader, venue, eurc_amount, usdc_amount, rate)
       SELECT * FROM unnest($1::bytea[], $2::bigint[], $3::bigint[], $4::text[], $5::bytea[], $6::bytea[], $7::numeric[], $8::numeric[], $9::float8[])
       ON CONFLICT DO NOTHING`,
      [
        rows.map((r) => hexToBytes(r.hash)),
        rows.map((r) => r.block),
        rows.map((r) => r.ts),
        rows.map((r) => r.trade!.side),
        rows.map((r) => hexToBytes(r.trade!.trader)),
        rows.map((r) => (r.trade!.venue ? hexToBytes(r.trade!.venue) : null)),
        rows.map((r) => r.trade!.eurcAmount.toString()),
        rows.map((r) => r.trade!.usdcAmount.toString()),
        rows.map((r) => r.trade!.rate),
      ],
    );
    this.log.info({ swaps: rows.length }, "fx trades recorded");
  }
}
