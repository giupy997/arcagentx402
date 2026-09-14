import { keccak256 } from "viem";
import type { CollectorConfig } from "../config.js";
import { bytesToHex, hexToBytes, type Db } from "../db/index.js";
import type { Logger } from "../log.js";
import type { RpcPool } from "../rpc/pool.js";
import type { RpcTransaction } from "../rpc/types.js";
import type { RuntimeState } from "../state.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ERROR_STRING_SELECTOR = "0x08c379a0";
const PANIC_SELECTOR = "0x4e487b71";

export interface DecodedRevert {
  kind: "error_string" | "panic" | "custom" | "empty";
  reason: string | null;
}

const PANIC_CODES: Record<number, string> = {
  0x00: "generic compiler panic",
  0x01: "assert(false)",
  0x11: "arithmetic overflow/underflow",
  0x12: "division by zero",
  0x21: "invalid enum conversion",
  0x22: "storage byte array misencoded",
  0x31: "pop() on empty array",
  0x32: "array index out of bounds",
  0x41: "memory allocation overflow",
  0x51: "call to uninitialised internal function",
};

/** Decode standard Solidity revert payloads. Pure; unit-tested. */
export function decodeRevertData(data: string | null | undefined): DecodedRevert {
  if (!data || data === "0x") return { kind: "empty", reason: null };
  const sel = data.slice(0, 10).toLowerCase();
  const body = data.slice(10);
  if (sel === ERROR_STRING_SELECTOR && body.length >= 128) {
    try {
      const len = Number(BigInt("0x" + body.slice(64, 128)));
      const str = Buffer.from(body.slice(128, 128 + len * 2), "hex").toString("utf8");
      return { kind: "error_string", reason: str };
    } catch {
      return { kind: "custom", reason: null };
    }
  }
  if (sel === PANIC_SELECTOR && body.length >= 64) {
    const code = Number(BigInt("0x" + body.slice(0, 64)));
    return { kind: "panic", reason: `Panic(0x${code.toString(16).padStart(2, "0")}): ${PANIC_CODES[code] ?? "unknown"}` };
  }
  return { kind: "custom", reason: sel };
}

/** Pull the `data` field out of the many shapes nodes use for eth_call revert errors. */
export function extractRevertData(err: { message?: string; data?: unknown }): string | null {
  const d = err.data;
  if (typeof d === "string" && d.startsWith("0x")) return d;
  if (d && typeof d === "object") {
    const o = d as { data?: unknown; originalError?: { data?: unknown } };
    if (typeof o.data === "string") return o.data;
    if (typeof o.originalError?.data === "string") return o.originalError.data;
  }
  const m = /(0x[0-9a-fA-F]{8,})/.exec(err.message ?? "");
  return m ? m[1]! : null;
}

/**
 * Best-effort enrichment, throttled so it never competes with ingestion:
 *   - failed txs: eth_call replay at parent block state -> revert data + decoded reason
 *   - contract deploys: eth_getCode at deploy block -> runtime code size/hash
 * Requires the RPC to serve historical state; when it does not, rows are marked rpc_error and retried
 * a few times with backoff, then left for a later pass with an archive endpoint.
 */
export class EnrichWorker {
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
    this.done = this.loop().catch((err) => this.log.error({ err }, "enrich crashed"));
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
          await sleep(5000);
          continue;
        }
        let did = 0;
        if (this.cfg.enrichReverts) did += await this.replayReverts(10);
        if (this.cfg.enrichCode) did += await this.fetchCodes(10);
        if (did === 0) await sleep(3000);
      } catch (err) {
        this.log.error({ err }, "enrich loop error");
        await sleep(3000);
      }
    }
  }

  async replayReverts(limit: number): Promise<number> {
    const rows = await this.db.query<{ tx_hash: Buffer; block_number: string; attempts: number; raw: RpcTransaction; input: Buffer | null }>(
      `SELECT r.tx_hash, r.block_number, r.attempts, t.raw, t.input
       FROM tx_reverts r JOIN transactions t ON t.hash = r.tx_hash
       WHERE r.replay_status IN ('pending', 'rpc_error') AND r.attempts < 5
       ORDER BY r.attempts ASC, r.block_number DESC LIMIT $1`,
      [limit],
    );
    const c = await this.db.query<{ n: string }>("SELECT count(*) AS n FROM tx_reverts WHERE replay_status = 'pending'");
    this.state.revertsPending = Number(c.rows[0]?.n ?? 0);
    for (const row of rows.rows) {
      const t = row.raw;
      const parent = Number(row.block_number) - 1;
      const data = row.input ? bytesToHex(row.input) : (t.input ?? "0x");
      const callObj: Record<string, unknown> = { from: t.from, data, value: t.value, gas: t.gas };
      if (t.to) callObj.to = t.to;
      // gasPrice matters for reverts that depend on msg.gas price/balance; pass what the tx used.
      if (t.gasPrice) callObj.gasPrice = t.gasPrice;
      else if (t.maxFeePerGas) callObj.maxFeePerGas = t.maxFeePerGas;
      try {
        const r = await this.pool.call<string>("eth_call", [callObj, `0x${parent.toString(16)}`], { maxAttempts: 2, quiet: true });
        if (r.outcome.ok) {
          await this.db.query("UPDATE tx_reverts SET replay_status = 'succeeded_on_replay', replayed_at = now(), attempts = attempts + 1 WHERE tx_hash = $1", [row.tx_hash]);
        } else {
          const data = extractRevertData(r.outcome.error);
          const stateMissing = /missing trie node|state (not|un)available|header not found|pruned|unknown block/i.test(r.outcome.error.message);
          if (stateMissing) {
            await this.db.query("UPDATE tx_reverts SET replay_status = 'rpc_error', rpc_error = $2, attempts = attempts + 1 WHERE tx_hash = $1", [row.tx_hash, r.outcome.error.message.slice(0, 300)]);
          } else {
            const dec = decodeRevertData(data);
            await this.db.query(
              "UPDATE tx_reverts SET replay_status = 'reverted', revert_data = $2, reason_kind = $3, reason = $4, rpc_error = $5, replayed_at = now(), attempts = attempts + 1 WHERE tx_hash = $1",
              [row.tx_hash, data ? hexToBytes(data) : null, dec.kind, dec.reason, r.outcome.error.message.slice(0, 300)],
            );
          }
        }
      } catch (err) {
        await this.db.query("UPDATE tx_reverts SET replay_status = 'rpc_error', rpc_error = $2, attempts = attempts + 1 WHERE tx_hash = $1", [row.tx_hash, (err as Error).message.slice(0, 300)]);
      }
    }
    return rows.rows.length;
  }

  async fetchCodes(limit: number): Promise<number> {
    const rows = await this.db.query<{ address: Buffer; block_number: string }>(
      "SELECT address, block_number FROM contract_deploys WHERE success AND runtime_code_size IS NULL ORDER BY block_number DESC LIMIT $1",
      [limit],
    );
    for (const row of rows.rows) {
      try {
        const code = await this.pool.callResult<string>("eth_getCode", [bytesToHex(row.address), "latest"], { maxAttempts: 2 });
        const size = (code.length - 2) / 2;
        await this.db.query("UPDATE contract_deploys SET runtime_code_size = $2, runtime_code_hash = $3 WHERE address = $1", [row.address, size, hexToBytes(keccak256(code as `0x${string}`))]);
      } catch (err) {
        this.log.debug({ err, address: bytesToHex(row.address) }, "getCode failed");
        // leave null; will be retried next pass (bounded by ORDER/LIMIT churn, acceptable)
        await sleep(500);
      }
    }
    return rows.rows.length;
  }
}
