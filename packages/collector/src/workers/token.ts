/**
 * Token watcher: records the two things the tokenomics page shows, straight from the chain.
 *   - burns:   CRA transferred to the dead address (buyback and burn)
 *   - payouts: USDC transferred out of the fee distributor
 * Nothing here is derived or estimated: every row is a log, with its transaction hash.
 */
import type { CollectorConfig } from "../config.js";
import { getState, hexToBytes, setState, type Db } from "../db/index.js";
import type { Logger } from "../log.js";
import type { RpcPool } from "../rpc/pool.js";
import type { RuntimeState } from "../state.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const DEAD = "0x000000000000000000000000000000000000dead";
const pad32 = (addr: string) => `0x${"0".repeat(24)}${addr.toLowerCase().replace(/^0x/, "")}`;

interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  logIndex: string;
  transactionHash: string;
  blockTimestamp?: string;
}

export class TokenWorker {
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
    this.done = this.loop().catch((err) => this.log.error({ err }, "token watcher crashed"));
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.done;
  }

  private async loop(): Promise<void> {
    const token = this.cfg.token;
    if (!token) return;
    let cursor = (await getState<{ cursor: number }>(this.db, "token"))?.cursor ?? token.startBlock;
    this.log.info({ token: token.address, distributor: token.distributor, from: cursor }, "token watcher started");
    while (!this.stopped) {
      try {
        const head = this.state.chainHead;
        if (head === null || cursor > head) {
          await sleep(5000);
          continue;
        }
        const to = Math.min(head, cursor + 1999);
        const [burns, payouts] = await Promise.all([
          this.logs(token.address, [TRANSFER_TOPIC, null, pad32(DEAD)], cursor, to),
          this.logs(token.usdc, [TRANSFER_TOPIC, pad32(token.distributor), null], cursor, to),
        ]);
        await this.write(burns, "burn");
        await this.write(payouts, "payout");
        cursor = to + 1;
        await setState(this.db, "token", { cursor });
        if (burns.length + payouts.length > 0) this.log.info({ burns: burns.length, payouts: payouts.length, upTo: to }, "token events recorded");
        if (to === head) await sleep(8000);
      } catch (err) {
        this.log.warn({ err: (err as Error).message }, "token watcher retry");
        await sleep(5000);
      }
    }
  }

  private async logs(address: string, topics: (string | null)[], fromBlock: number, toBlock: number): Promise<RawLog[]> {
    const r = await this.pool.callResult<RawLog[]>("eth_getLogs", [{ address, topics, fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}` }], { maxAttempts: 3, quiet: true });
    return Array.isArray(r) ? r : [];
  }

  private async write(logs: RawLog[], kind: "burn" | "payout"): Promise<void> {
    if (logs.length === 0) return;
    // blockTimestamp is an Arc extension; fall back to the block we already store.
    const rows = await Promise.all(
      logs.map(async (l) => {
        const blockNumber = Number(BigInt(l.blockNumber));
        let ts = l.blockTimestamp ? Number(BigInt(l.blockTimestamp)) : 0;
        if (!ts) {
          const r = await this.db.query<{ t: string }>('SELECT "timestamp" AS t FROM blocks WHERE number = $1', [blockNumber]);
          ts = r.rows[0] ? Number(r.rows[0].t) : Math.floor(Date.now() / 1000);
        }
        return {
          blockNumber,
          logIndex: Number(BigInt(l.logIndex)),
          txHash: hexToBytes(l.transactionHash),
          ts,
          from: hexToBytes(`0x${l.topics[1]!.slice(26)}`),
          to: hexToBytes(`0x${l.topics[2]!.slice(26)}`),
          amount: BigInt(l.data).toString(),
        };
      }),
    );
    await this.db.query(
      `INSERT INTO token_events (block_number, log_index, tx_hash, "timestamp", kind, "from", "to", amount)
       SELECT * FROM unnest($1::bigint[], $2::int[], $3::bytea[], $4::bigint[], $5::text[], $6::bytea[], $7::bytea[], $8::numeric[])
       ON CONFLICT DO NOTHING`,
      [rows.map((r) => r.blockNumber), rows.map((r) => r.logIndex), rows.map((r) => r.txHash), rows.map((r) => r.ts), rows.map(() => kind), rows.map((r) => r.from), rows.map((r) => r.to), rows.map((r) => r.amount)],
    );
  }
}
