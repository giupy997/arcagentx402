/**
 * Direct payments from before the collector extracted them.
 *
 * Every block ingested from now on carries its own: parseBundle reads them from the receipts the
 * collector fetches anyway, in light mode too. Blocks read before that, and history below the
 * collector's start when PAYMENTS_START_BLOCK asks for it, are filled here once, from the chain: the
 * AuthorizationUsed events by range, then the receipts of the transactions that carry them. It stops
 * at the first block ingested with extraction, and gives way whenever the head falls behind.
 */
import type { CollectorConfig } from "../config.js";
import { getState, hexToBytes, setState, type Db } from "../db/index.js";
import { parseLogs } from "../ingest/parse.js";
import { AUTHORIZATION_USED_TOPIC, pairAuthorizations, storedFromParsed, type DirectPaymentRow } from "../ingest/payments.js";
import { writeDirectPayments } from "../ingest/write.js";
import type { Logger } from "../log.js";
import { RpcError } from "../rpc/client.js";
import type { RpcPool } from "../rpc/pool.js";
import type { RpcLog, RpcReceipt } from "../rpc/types.js";
import type { RuntimeState } from "../state.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (n: number) => `0x${n.toString(16)}`;
/**
 * Log ranges: as wide as the endpoints take (some refuse 10,000 blocks), halved when every endpoint
 * refuses one, widened again after each range that worked. Most of Arc's early history is empty, and
 * a fixed small range spends hours asking about nothing.
 */
const WINDOW_MAX = 9000;
const WINDOW_MIN = 500;
const RECEIPTS_PER_BATCH = 50;

/** Where the history fill stands. `until` is the first block ingested with extraction: below it, this fills. */
export interface PaymentsFill {
  from: number;
  until: number;
  cursor: number;
}

/**
 * What to fill next. A saved fill that is not done goes on. A done fill is followed by an older one when
 * PAYMENTS_START_BLOCK points below where the index begins; otherwise there is nothing to do. With
 * nothing saved, the first fill runs from PAYMENTS_START_BLOCK, or the lowest block collected, up to
 * the first block the head worker will ingest with extraction.
 */
export function nextFill(saved: PaymentsFill | null, startBlock: number, lowest: number | null, headCursor: number): PaymentsFill {
  if (saved) {
    if (saved.cursor < saved.until || startBlock <= 0 || startBlock >= saved.from) return saved;
    return { from: startBlock, until: saved.from, cursor: startBlock };
  }
  const until = headCursor + 1;
  const from = startBlock > 0 ? startBlock : (lowest ?? until);
  return { from, until, cursor: Math.min(from, until) };
}

/** The payments in receipts fetched on their own, the way parseBundle finds them in a block. */
export function paymentsFromReceipts(receipts: readonly RpcReceipt[]): DirectPaymentRow[] {
  const rows: DirectPaymentRow[] = [];
  for (const r of receipts) {
    if (r.status !== "0x1") continue;
    const blockNumber = Number(BigInt(r.blockNumber));
    const txIndex = Number(BigInt(r.transactionIndex));
    // Arc puts the block's time on every log; a receipt without it cannot be dated here.
    const stamp = r.logs.find((l) => typeof l.blockTimestamp === "string")?.blockTimestamp as string | undefined;
    if (!stamp) throw new Error(`receipt ${r.transactionHash} has no blockTimestamp on its logs`);
    const timestamp = Number(BigInt(stamp));
    for (const p of pairAuthorizations(parseLogs(r, blockNumber, txIndex).map(storedFromParsed))) {
      rows.push({ ...p, timestamp, relayer: hexToBytes(r.from), called: r.to ? hexToBytes(r.to) : null });
    }
  }
  return rows;
}

export class PaymentsWorker {
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
    this.done = this.loop().catch((err) => this.log.error({ err }, "direct payments history fill crashed"));
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.done;
  }

  private async loop(): Promise<void> {
    if (!this.cfg.payments.enabled) return;
    // A finished fill can be followed by an older one, when PAYMENTS_START_BLOCK asks to go further back.
    for (let fill = await this.plan(); !this.stopped && fill.cursor < fill.until; fill = await this.plan()) await this.run(fill);
  }

  private async run(start: PaymentsFill): Promise<void> {
    let fill = start;
    let window = WINDOW_MAX;
    this.log.info({ ...fill }, "direct payments history fill started");
    while (!this.stopped && fill.cursor < fill.until) {
      try {
        const lag = this.state.lag();
        if (lag !== null && lag > this.cfg.lagAlertBlocks) {
          await sleep(5000);
          continue;
        }
        const to = Math.min(fill.cursor + window - 1, fill.until - 1);
        let logs: RpcLog[];
        try {
          logs = await this.authLogs(fill.cursor, to);
        } catch (err) {
          if (window > WINDOW_MIN) {
            window = Math.max(WINDOW_MIN, Math.floor(window / 2));
            continue;
          }
          throw err;
        }
        const receipts = await this.receipts([...new Set(logs.map((l) => l.transactionHash.toLowerCase()))]);
        await writeDirectPayments(this.db, { directPayments: paymentsFromReceipts(receipts) });
        fill = { ...fill, cursor: to + 1 };
        await setState(this.db, "direct_payments", fill);
        window = Math.min(WINDOW_MAX, window * 2);
        if (fill.cursor >= fill.until) this.log.info({ ...fill }, "direct payments history filled");
      } catch (err) {
        this.log.warn({ err: (err as Error).message, cursor: fill.cursor }, "direct payments history fill retry");
        await sleep(10_000);
      }
    }
  }

  /** The fill to run now, saved before it starts. Waits for the head worker to know where it is. */
  private async plan(): Promise<PaymentsFill> {
    const found = await getState<PaymentsFill>(this.db, "direct_payments");
    const saved = found && typeof found.until === "number" ? found : null;
    if (!saved) while (this.state.headCursor === null && !this.stopped) await sleep(1000);
    const min = saved ? null : (await this.db.query<{ min: string | null }>("SELECT min(number) AS min FROM blocks")).rows[0]?.min;
    const fill = nextFill(saved, this.cfg.payments.startBlock, min === null || min === undefined ? null : Number(min), this.state.headCursor ?? 0);
    if (fill !== saved) await setState(this.db, "direct_payments", fill);
    return fill;
  }

  /**
   * AuthorizationUsed logs of a range, from any contract. An endpoint that pruned the range, or refuses
   * its size, answers with an error the pool does not retry elsewhere: ask the others before giving up.
   */
  private async authLogs(from: number, to: number): Promise<RpcLog[]> {
    const exclude = new Set<string>();
    for (;;) {
      try {
        const r = await this.pool.callResult<RpcLog[]>("eth_getLogs", [{ fromBlock: hex(from), toBlock: hex(to), topics: [AUTHORIZATION_USED_TOPIC] }], { exclude, maxAttempts: 3, quiet: true });
        return Array.isArray(r) ? r.filter((l) => !l.removed) : [];
      } catch (err) {
        if (err instanceof RpcError && err.endpoint !== "pool" && !exclude.has(err.endpoint)) {
          exclude.add(err.endpoint);
          continue;
        }
        throw err;
      }
    }
  }

  /** Receipts by hash, in batches. A batch with a missing receipt is asked of another endpoint. */
  private async receipts(hashes: readonly string[]): Promise<RpcReceipt[]> {
    const out: RpcReceipt[] = [];
    for (let i = 0; i < hashes.length; i += RECEIPTS_PER_BATCH) {
      const chunk = hashes.slice(i, i + RECEIPTS_PER_BATCH);
      const exclude = new Set<string>();
      for (;;) {
        const r = await this.pool.batch<RpcReceipt | null>(chunk.map((h) => ({ method: "eth_getTransactionReceipt", params: [h] })), { exclude, maxAttempts: 3, quiet: true });
        const got = r.outcomes.flatMap((o) => (o.ok && o.result ? [o.result] : []));
        if (got.length === chunk.length) {
          out.push(...got);
          break;
        }
        exclude.add(r.endpoint);
      }
    }
    return out;
  }
}
