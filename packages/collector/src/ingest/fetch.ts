import type { RpcPool } from "../rpc/pool.js";
import type { RpcBlock, RpcReceipt } from "../rpc/types.js";
import { ParseError, parseBundle, type ParsedBlockBundle, type RawMode } from "./parse.js";

export interface FetchedBlock {
  number: number;
  bundle: ParsedBlockBundle;
  endpoint: string;
  fetchMs: number;
}

export interface FetchFailure {
  number: number;
  reason: string;
  endpoint: string | null;
}

export interface FetchResult {
  ok: FetchedBlock[];
  failed: FetchFailure[];
}

const toHex = (n: number): `0x${string}` => `0x${n.toString(16)}`;

/**
 * Fetch full blocks + receipts for a set of block numbers in ONE JSON-RPC batch (2 calls per block).
 * Per-block failures (null block = node behind, mismatched receipts = node inconsistency) are returned,
 * not thrown, so the caller can retry only those, preferably on another endpoint.
 */
export async function fetchBlocks(pool: RpcPool, numbers: readonly number[], exclude?: ReadonlySet<string>, rawMode: RawMode = "compact"): Promise<FetchResult> {
  if (numbers.length === 0) return { ok: [], failed: [] };
  const calls = numbers.flatMap((n) => [
    { method: "eth_getBlockByNumber", params: [toHex(n), true] },
    { method: "eth_getBlockReceipts", params: [toHex(n)] },
  ]);
  const routed = await pool.batch<RpcBlock | RpcReceipt[] | null>(calls, { ...(exclude ? { exclude } : {}), blockNumber: numbers[0]! });
  const ok: FetchedBlock[] = [];
  const failed: FetchFailure[] = [];
  const perBlockMs = Math.round(routed.durationMs / numbers.length);
  for (let i = 0; i < numbers.length; i++) {
    const n = numbers[i]!;
    const bo = routed.outcomes[2 * i]!;
    const ro = routed.outcomes[2 * i + 1]!;
    if (!bo.ok) {
      failed.push({ number: n, reason: `block: ${bo.error.code} ${bo.error.message}`, endpoint: routed.endpoint });
      continue;
    }
    if (!ro.ok) {
      failed.push({ number: n, reason: `receipts: ${ro.error.code} ${ro.error.message}`, endpoint: routed.endpoint });
      continue;
    }
    if (bo.result === null || bo.result === undefined) {
      failed.push({ number: n, reason: "block not available on this node yet", endpoint: routed.endpoint });
      continue;
    }
    if (!Array.isArray(ro.result)) {
      failed.push({ number: n, reason: "receipts not an array", endpoint: routed.endpoint });
      continue;
    }
    try {
      const bundle = parseBundle(bo.result as RpcBlock, ro.result as RpcReceipt[], rawMode);
      if (bundle.block.number !== n) throw new ParseError(`asked ${n}, got ${bundle.block.number}`);
      ok.push({ number: n, bundle, endpoint: routed.endpoint, fetchMs: perBlockMs });
    } catch (err) {
      failed.push({ number: n, reason: err instanceof Error ? err.message : String(err), endpoint: routed.endpoint });
    }
  }
  return { ok, failed };
}
