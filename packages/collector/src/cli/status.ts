import { loadConfig } from "../config.js";
import { createDb } from "../db/index.js";
import { log } from "../log.js";

/** Prints a DB-side summary (works whether or not the collector is running). */
async function main() {
  const cfg = loadConfig();
  const db = createDb(cfg.databaseUrl, log);
  const q = async <T extends object>(sql: string) => (await db.query<T>(sql)).rows;
  const [range] = await q<{ min: string | null; max: string | null; n: string; txs: string | null }>(
    "SELECT min(number) AS min, max(number) AS max, count(*) AS n, sum(tx_count) AS txs FROM blocks",
  );
  const [gaps] = await q<{ n: string; blocks: string | null }>("SELECT count(*) AS n, sum(to_block - from_block + 1) AS blocks FROM block_gaps");
  const [deploys] = await q<{ n: string; ok: string }>("SELECT count(*) AS n, count(*) FILTER (WHERE success) AS ok FROM contract_deploys");
  const [reverts] = await q<{ n: string; decoded: string; pending: string }>(
    "SELECT count(*) AS n, count(*) FILTER (WHERE replay_status='reverted') AS decoded, count(*) FILTER (WHERE replay_status IN ('pending','rpc_error')) AS pending FROM tx_reverts",
  );
  const state = await q<{ key: string; value: unknown; updated_at: string }>("SELECT key, value, updated_at FROM collector_state ORDER BY key");
  const [payments] = await q<{ n: string; payers: string; payees: string; relayers: string; first_block: string | null; last_block: string | null }>(
    "SELECT count(*) AS n, count(DISTINCT payer) AS payers, count(DISTINCT payee) AS payees, count(DISTINCT relayer) AS relayers, min(block_number) AS first_block, max(block_number) AS last_block FROM direct_payments",
  ).catch(() => [undefined]);
  const fees = await q<{ blocks: string; avg_ratio: number; min_fee: string; max_fee: string }>(
    "SELECT count(*) AS blocks, avg(gas_used_ratio) AS avg_ratio, min(base_fee_per_gas) AS min_fee, max(base_fee_per_gas) AS max_fee FROM blocks WHERE number > (SELECT max(number) FROM blocks) - 7200",
  );
  const heads = await q<{ endpoint: string; n: string; avg_rtt: number; errors: string; max_latest: string | null }>(
    "SELECT endpoint, count(*) AS n, avg(rtt_ms) AS avg_rtt, count(error) AS errors, max(latest) AS max_latest FROM head_observations WHERE observed_at > now() - interval '1 hour' GROUP BY endpoint ORDER BY endpoint",
  );
  const latency = await q<{ p50: number | null; p95: number | null; n: string }>(
    "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM observed_at) - \"timestamp\") AS p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM observed_at) - \"timestamp\") AS p95, count(*) AS n FROM blocks WHERE observed_at IS NOT NULL AND observed_at > now() - interval '1 hour'",
  );
  console.log(JSON.stringify({ network: cfg.network, chainId: cfg.chainId, blocks: range, gaps, deploys, reverts, directPayments: payments ?? "table missing: run the collector once to migrate", state, lastHourFees: fees[0], rpcLastHour: heads, liveLatencySecondsLastHour: latency[0] }, null, 2));
  await db.end();
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
