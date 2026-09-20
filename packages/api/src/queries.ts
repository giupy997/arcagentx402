import { formatUsdc18, formatUsdc6, txFee18, usdc18, usdc6, type Usdc18 } from "@cra-agent/accounting";
import { hex, type Db } from "./db.js";

const usd = (wei18: string | bigint | null, digits = 6): string | null =>
  wei18 === null ? null : formatUsdc18(usdc18(BigInt(wei18)), { maxFractionDigits: digits });
const num = (v: string | number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

const GAS_NATIVE_TRANSFER = 21_000n;
const GAS_ERC20_TRANSFER = 65_000n; // typical USDC transfer on Arc, observed ~50-65k

export interface NetworkSummary {
  network: string;
  chainId: number;
  genesisHash: string | null;
  head: { number: number; timestamp: number; ageSeconds: number } | null;
  ingestedHead: number | null;
  /** Best chain head seen by the collector's RPC probes in the last 2 minutes (null if none). */
  chainHead: number | null;
  lagBlocks: number | null;
  blockTimeSeconds: number | null;
  txPerSecond: number | null;
  finality: { p50Seconds: number | null; p95Seconds: number | null; samples: number };
  totals: { blocks: number; transactions: number; deploys: number };
  collector: { lastBlockAgeSeconds: number | null; gapsOpen: number };
}

export async function networkSummary(db: Db, network: string, chainId: number): Promise<NetworkSummary> {
  const [head, chain, rate, fin, totals, gaps, best] = await Promise.all([
    db.query<{ number: string; timestamp: string; inserted_at: string }>("SELECT number, \"timestamp\", inserted_at FROM blocks ORDER BY number DESC LIMIT 1"),
    db.query<{ value: { genesisHash: string } }>("SELECT value FROM collector_state WHERE key = 'chain'"),
    db.query<{ blocks: string; txs: string; span: string }>(
      `SELECT count(*) AS blocks, coalesce(sum(tx_count),0) AS txs, max("timestamp") - min("timestamp") AS span
       FROM blocks WHERE number > (SELECT max(number) FROM blocks) - 1200`,
    ),
    db.query<{ p50: number | null; p95: number | null; n: string }>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM observed_at) - "timestamp") AS p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM observed_at) - "timestamp") AS p95, count(*) AS n
       FROM blocks WHERE observed_at IS NOT NULL AND observed_at > now() - interval '1 hour'`,
    ),
    db.query<{ blocks: string; txs: string; deploys: string }>(
      "SELECT (SELECT count(*) FROM blocks) AS blocks, (SELECT coalesce(sum(tx_count),0) FROM blocks) AS txs, (SELECT count(*) FROM contract_deploys) AS deploys",
    ),
    db.query<{ n: string }>("SELECT count(*) AS n FROM block_gaps"),
    db.query<{ best: string | null }>("SELECT max(latest) AS best FROM head_observations WHERE observed_at > now() - interval '2 minutes'"),
  ]);
  const h = head.rows[0];
  const chainHead = best.rows[0]?.best === null || best.rows[0]?.best === undefined ? null : Number(best.rows[0].best);
  const r = rate.rows[0];
  const span = r ? Number(r.span) : 0;
  const nowSec = Date.now() / 1000;
  return {
    network,
    chainId,
    genesisHash: chain.rows[0]?.value.genesisHash ?? null,
    head: h ? { number: Number(h.number), timestamp: Number(h.timestamp), ageSeconds: Math.max(0, Math.round(nowSec - Number(h.timestamp))) } : null,
    ingestedHead: h ? Number(h.number) : null,
    chainHead,
    lagBlocks: h && chainHead !== null ? Math.max(0, chainHead - Number(h.number)) : null,
    blockTimeSeconds: r && Number(r.blocks) > 1 && span > 0 ? Number((span / (Number(r.blocks) - 1)).toFixed(3)) : null,
    txPerSecond: r && span > 0 ? Number((Number(r.txs) / span).toFixed(2)) : null,
    finality: { p50Seconds: num(fin.rows[0]?.p50), p95Seconds: num(fin.rows[0]?.p95), samples: Number(fin.rows[0]?.n ?? 0) },
    totals: { blocks: Number(totals.rows[0]?.blocks ?? 0), transactions: Number(totals.rows[0]?.txs ?? 0), deploys: Number(totals.rows[0]?.deploys ?? 0) },
    collector: { lastBlockAgeSeconds: h ? Math.round((Date.now() - new Date(h.inserted_at).getTime()) / 1000) : null, gapsOpen: Number(gaps.rows[0]?.n ?? 0) },
  };
}

export interface FeePoint {
  t: number; // unix seconds (minute bucket)
  baseFeeGwei: number;
  utilization: number; // 0..1 avg gas_used_ratio
  blocks: number;
}

export interface FeeSummary {
  current: { baseFeeWei: string; baseFeeGwei: number; nextBaseFeeWei: string | null; nextBaseFeeGwei: number | null; blockNumber: number } | null;
  floorGwei: number; // protocol minimum (docs: 20 gwei testnet)
  costNow: { nativeTransferUsdc: string; erc20TransferUsdc: string } | null;
  last24h: { minGwei: number | null; maxGwei: number | null; avgUtilization: number | null } | null;
  series: FeePoint[];
  /** Averages per class from block_stats (available in both collector modes). failed is only attributed to contract calls. */
  byOperation: Array<{ op: string; count: number; avgFeeUsdc: string | null; failed: number }>;
}

export async function feeSummary(db: Db, windowMinutes = 60): Promise<FeeSummary> {
  const [cur, day, series, ops] = await Promise.all([
    db.query<{ number: string; base_fee_per_gas: string; next_base_fee_per_gas: string | null }>("SELECT number, base_fee_per_gas, next_base_fee_per_gas FROM blocks ORDER BY number DESC LIMIT 1"),
    db.query<{ mn: string | null; mx: string | null; util: number | null }>(
      `SELECT min(base_fee_per_gas) AS mn, max(base_fee_per_gas) AS mx, avg(gas_used_ratio) AS util FROM blocks WHERE "timestamp" > extract(epoch FROM now()) - 86400`,
    ),
    db.query<{ t: string; fee: string; util: number; n: string }>(
      `SELECT (("timestamp" / 60) * 60) AS t, avg(base_fee_per_gas) AS fee, avg(gas_used_ratio) AS util, count(*) AS n
       FROM blocks WHERE "timestamp" > extract(epoch FROM now()) - $1 GROUP BY 1 ORDER BY 1`,
      [windowMinutes * 60],
    ),
    db.query<{ op: string; n: string; fee: string | null; failed: string }>(
      `WITH w AS (SELECT * FROM block_stats WHERE block_number > (SELECT max(number) FROM blocks) - $1)
       SELECT 'native_transfer' AS op, sum(native_transfers) AS n, sum(fee_native) AS fee, 0 AS failed FROM w
       UNION ALL SELECT 'erc20_transfer', sum(erc20_transfers), sum(fee_erc20), 0 FROM w
       UNION ALL SELECT 'contract_call', sum(contract_calls), sum(fee_calls), sum(failed) FROM w
       UNION ALL SELECT 'deploy', sum(deploys), sum(fee_deploys), 0 FROM w`,
      [Math.round((windowMinutes * 60) / 0.5)],
    ),
  ]);
  const c = cur.rows[0];
  const gwei = (wei: string | null): number | null => (wei === null ? null : Number(BigInt(wei)) / 1e9);
  const price = c ? BigInt(c.base_fee_per_gas) : null;
  const cost = (gas: bigint, p: bigint): string => formatUsdc18(txFee18(gas, p), { maxFractionDigits: 6 });
  return {
    current: c
      ? { baseFeeWei: c.base_fee_per_gas, baseFeeGwei: gwei(c.base_fee_per_gas)!, nextBaseFeeWei: c.next_base_fee_per_gas, nextBaseFeeGwei: gwei(c.next_base_fee_per_gas), blockNumber: Number(c.number) }
      : null,
    floorGwei: 20,
    costNow: price !== null ? { nativeTransferUsdc: cost(GAS_NATIVE_TRANSFER, price), erc20TransferUsdc: cost(GAS_ERC20_TRANSFER, price) } : null,
    last24h: day.rows[0] ? { minGwei: gwei(day.rows[0].mn), maxGwei: gwei(day.rows[0].mx), avgUtilization: num(day.rows[0].util) } : null,
    series: series.rows.map((r) => ({ t: Number(r.t), baseFeeGwei: Number(BigInt(Math.round(Number(r.fee)).toString())) / 1e9, utilization: Number(r.util), blocks: Number(r.n) })),
    byOperation: ops.rows
      .filter((r) => Number(r.n) > 0)
      .sort((a, b) => Number(b.n) - Number(a.n))
      .map((r) => ({
        op: r.op,
        count: Number(r.n),
        avgFeeUsdc: r.fee === null ? null : usd((BigInt(r.fee) / BigInt(r.n)).toString()),
        failed: Number(r.failed),
      })),
  };
}

export async function feeEstimate(db: Db, gas: bigint): Promise<{ gas: string; baseFeeGwei: number; nextBaseFeeGwei: number | null; costUsdc: string; costNextUsdc: string | null; blockNumber: number } | null> {
  const r = await db.query<{ number: string; base_fee_per_gas: string; next_base_fee_per_gas: string | null }>("SELECT number, base_fee_per_gas, next_base_fee_per_gas FROM blocks ORDER BY number DESC LIMIT 1");
  const c = r.rows[0];
  if (!c) return null;
  const p = BigInt(c.base_fee_per_gas);
  const n = c.next_base_fee_per_gas ? BigInt(c.next_base_fee_per_gas) : null;
  const fmt = (f: Usdc18) => formatUsdc18(f, { maxFractionDigits: 8 });
  return {
    gas: gas.toString(),
    baseFeeGwei: Number(p) / 1e9,
    nextBaseFeeGwei: n === null ? null : Number(n) / 1e9,
    costUsdc: fmt(txFee18(gas, p)),
    costNextUsdc: n === null ? null : fmt(txFee18(gas, n)),
    blockNumber: Number(c.number),
  };
}

export async function activity(db: Db, windowMinutes = 60) {
  const [perMinute, failed, selectors, emitters] = await Promise.all([
    db.query<{ t: string; txs: string; blocks: string }>(
      `SELECT (("timestamp" / 60) * 60) AS t, sum(tx_count) AS txs, count(*) AS blocks FROM blocks WHERE "timestamp" > extract(epoch FROM now()) - $1 GROUP BY 1 ORDER BY 1`,
      [windowMinutes * 60],
    ),
    db.query<{ n: string; failed: string }>(
      `SELECT coalesce(sum(tx_count),0) AS n, coalesce(sum(failed),0) AS failed FROM block_stats WHERE block_number > (SELECT max(number) FROM blocks) - $1`,
      [Math.round((windowMinutes * 60) / 0.5)],
    ),
    db.query<{ selector: Buffer; n: string }>(
      `SELECT input_selector AS selector, count(*) AS n FROM transactions WHERE input_selector IS NOT NULL AND block_number > (SELECT max(number) FROM blocks) - $1 GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
      [Math.round((windowMinutes * 60) / 0.5)],
    ),
    db.query<{ address: Buffer; label: string | null; protocol: string | null; n: string }>(
      `SELECT l.address, k.label, k.protocol, count(*) AS n FROM logs l LEFT JOIN known_contracts k ON k.address = l.address
       WHERE l.block_number > (SELECT max(number) FROM blocks) - $1 GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 8`,
      [Math.round((windowMinutes * 60) / 0.5)],
    ),
  ]);
  return {
    windowMinutes,
    txPerMinute: perMinute.rows.map((r) => ({ t: Number(r.t), txs: Number(r.txs), blocks: Number(r.blocks) })),
    failureRate: Number(failed.rows[0]?.n ?? 0) > 0 ? Number(failed.rows[0]!.failed) / Number(failed.rows[0]!.n) : null,
    txCount: Number(failed.rows[0]?.n ?? 0),
    topSelectors: selectors.rows.map((r) => ({ selector: hex(r.selector), count: Number(r.n), name: SELECTOR_NAMES[hex(r.selector) ?? ""] ?? null })),
    topLogEmitters: emitters.rows.map((r) => ({ address: hex(r.address), label: r.label, protocol: r.protocol, count: Number(r.n) })),
  };
}

const SELECTOR_NAMES: Record<string, string> = {
  "0xa9059cbb": "transfer(address,uint256)",
  "0x095ea7b3": "approve(address,uint256)",
  "0x23b872dd": "transferFrom(address,address,uint256)",
  "0x40c10f19": "mint(address,uint256)",
  "0xd0e30db0": "deposit()",
  "0x2e1a7d4d": "withdraw(uint256)",
  "0x3593564c": "execute(bytes,bytes[],uint256)",
  "0xac9650d8": "multicall(bytes[])",
  "0x1e6c2b6f": "mint",
};

export async function recentDeploys(db: Db, limit: number, network: string) {
  const r = await db.query<{ address: Buffer; deployer: Buffer; block_number: string; block_timestamp: string; tx_hash: Buffer; init_code_size: number; runtime_code_size: number | null; success: boolean; label: string | null; protocol: string | null }>(
    `SELECT d.address, d.deployer, d.block_number, d.block_timestamp, d.tx_hash, d.init_code_size, d.runtime_code_size, d.success, k.label, k.protocol
     FROM contract_deploys d LEFT JOIN known_contracts k ON k.address = d.address AND k.network = $2
     ORDER BY d.block_number DESC, d.tx_index DESC LIMIT $1`,
    [limit, network],
  );
  return r.rows.map((d) => ({
    address: hex(d.address),
    deployer: hex(d.deployer),
    blockNumber: Number(d.block_number),
    timestamp: Number(d.block_timestamp),
    txHash: hex(d.tx_hash),
    initCodeSize: d.init_code_size,
    runtimeCodeSize: d.runtime_code_size,
    success: d.success,
    label: d.label,
    protocol: d.protocol,
  }));
}

export async function deployStats(db: Db) {
  const r = await db.query<{ t: string; n: string; deployers: string }>(
    `SELECT (block_timestamp / 3600) * 3600 AS t, count(*) AS n, count(DISTINCT deployer) AS deployers FROM contract_deploys
     WHERE block_timestamp > extract(epoch FROM now()) - 86400 GROUP BY 1 ORDER BY 1`,
  );
  return r.rows.map((x) => ({ t: Number(x.t), deploys: Number(x.n), deployers: Number(x.deployers) }));
}

export async function rpcStatus(db: Db) {
  const r = await db.query<{ endpoint: string; n: string; rtt_avg: number; rtt_p95: number; errors: string; max_latest: string | null; last_seen: string; last_lag: string | null }>(
    `WITH w AS (SELECT * FROM head_observations WHERE observed_at > now() - interval '15 minutes'),
          best AS (SELECT observed_at, max(latest) AS best_latest FROM w GROUP BY observed_at)
     SELECT w.endpoint, count(*) AS n, avg(w.rtt_ms) AS rtt_avg, percentile_cont(0.95) WITHIN GROUP (ORDER BY w.rtt_ms) AS rtt_p95,
            count(w.error) AS errors, max(w.latest) AS max_latest, max(w.observed_at) AS last_seen,
            avg(b.best_latest - w.latest) FILTER (WHERE w.latest IS NOT NULL) AS last_lag
     FROM w JOIN best b USING (observed_at) GROUP BY w.endpoint ORDER BY w.endpoint`,
  );
  const errs = await db.query<{ endpoint: string; n: string }>("SELECT endpoint, count(*) AS n FROM rpc_errors WHERE at > now() - interval '15 minutes' GROUP BY 1");
  const errMap = new Map(errs.rows.map((e) => [e.endpoint, Number(e.n)]));
  return r.rows.map((e) => ({
    endpoint: e.endpoint,
    probes: Number(e.n),
    rttAvgMs: Math.round(Number(e.rtt_avg)),
    rttP95Ms: Math.round(Number(e.rtt_p95)),
    probeErrors: Number(e.errors),
    callErrors: errMap.get(e.endpoint) ?? 0,
    avgLagBlocks: e.last_lag === null ? null : Number(Number(e.last_lag).toFixed(2)),
    maxLatest: e.max_latest === null ? null : Number(e.max_latest),
    lastSeen: e.last_seen,
  }));
}


// ---------------------------------------------------------------------------
// Token: burns and payouts, straight from the chain via the collector's watcher
// ---------------------------------------------------------------------------

const CRA_DECIMALS = 18n;
/** Payout amounts come from the USDC ERC-20 interface: 6 decimals, not the 18-decimal gas view. */
const usd6 = (raw: string | null): string => formatUsdc6(usdc6(BigInt(raw ?? "0")), { maxFractionDigits: 2 });
const usd6Exact = (raw: string | null): string => formatUsdc6(usdc6(BigInt(raw ?? "0")));
/** Format raw units with the given decimals, no floats. */
function formatUnits(raw: string, decimals: bigint, maxFrac = 2): string {
  const neg = raw.startsWith("-");
  const v = BigInt(neg ? raw.slice(1) : raw);
  const base = 10n ** decimals;
  const int = (v / base).toString();
  let frac = (v % base).toString().padStart(Number(decimals), "0").slice(0, maxFrac).replace(/0+$/, "");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${grouped}${frac ? "." + frac : ""}`;
}

export interface TokenEvent {
  kind: "burn" | "payout";
  blockNumber: number;
  timestamp: number;
  txHash: string | null;
  from: string | null;
  to: string | null;
  amount: string;
  amountFormatted: string;
}

export interface TokenSummary {
  token: { address: string; distributor: string; symbol: string; decimals: number } | null;
  burned: { total: string; totalFormatted: string; supplyShare: number | null; events: number; last24h: string; last24hFormatted: string; lastAt: number | null };
  payouts: { totalUsdc: string; last24hUsdc: string; events: number; recipients: number; lastAt: number | null };
  perHour: Array<{ t: number; burned: string; burnedFormatted: string; payoutUsdc: string }>;
  recent: TokenEvent[];
}

const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;

export async function tokenSummary(db: Db, address: string | null, distributor: string | null): Promise<TokenSummary> {
  const empty: TokenSummary = {
    token: null,
    burned: { total: "0", totalFormatted: "0", supplyShare: null, events: 0, last24h: "0", last24hFormatted: "0", lastAt: null },
    payouts: { totalUsdc: "0", last24hUsdc: "0", events: 0, recipients: 0, lastAt: null },
    perHour: [],
    recent: [],
  };
  if (!address || !distributor) return empty;
  const [burn, pay, perHour, recent] = await Promise.all([
    db.query<{ total: string | null; n: string; last24h: string | null; last_at: string | null }>(
      `SELECT sum(amount) AS total, count(*) AS n,
              sum(amount) FILTER (WHERE "timestamp" > extract(epoch FROM now()) - 86400) AS last24h,
              max("timestamp") AS last_at
       FROM token_events WHERE kind = 'burn'`,
    ),
    db.query<{ total: string | null; n: string; last24h: string | null; recipients: string; last_at: string | null }>(
      `SELECT sum(amount) AS total, count(*) AS n,
              sum(amount) FILTER (WHERE "timestamp" > extract(epoch FROM now()) - 86400) AS last24h,
              count(DISTINCT "to") AS recipients, max("timestamp") AS last_at
       FROM token_events WHERE kind = 'payout'`,
    ),
    db.query<{ t: string; burned: string | null; payout: string | null }>(
      `SELECT ("timestamp" / 3600) * 3600 AS t,
              sum(amount) FILTER (WHERE kind = 'burn') AS burned,
              sum(amount) FILTER (WHERE kind = 'payout') AS payout
       FROM token_events WHERE "timestamp" > extract(epoch FROM now()) - 86400 * 3 GROUP BY 1 ORDER BY 1`,
    ),
    db.query<{ kind: "burn" | "payout"; block_number: string; timestamp: string; tx_hash: Buffer; from: Buffer; to: Buffer; amount: string }>(
      `SELECT kind, block_number, "timestamp", tx_hash, "from", "to", amount FROM token_events ORDER BY "timestamp" DESC, log_index DESC LIMIT 25`,
    ),
  ]);
  const b = burn.rows[0]!;
  const p = pay.rows[0]!;
  const burnedTotal = BigInt(b.total ?? "0");
  return {
    token: { address, distributor, symbol: "CRA", decimals: 18 },
    burned: {
      total: burnedTotal.toString(),
      totalFormatted: formatUnits(burnedTotal.toString(), CRA_DECIMALS, 0),
      supplyShare: Number((burnedTotal * 1_000_000n) / TOTAL_SUPPLY) / 10_000,
      events: Number(b.n),
      last24h: (b.last24h ?? "0").toString(),
      last24hFormatted: formatUnits(b.last24h ?? "0", CRA_DECIMALS, 0),
      lastAt: b.last_at === null ? null : Number(b.last_at),
    },
    payouts: {
      totalUsdc: usd6(p.total),
      last24hUsdc: usd6(p.last24h),
      events: Number(p.n),
      recipients: Number(p.recipients),
      lastAt: p.last_at === null ? null : Number(p.last_at),
    },
    perHour: perHour.rows.map((r) => ({
      t: Number(r.t),
      burned: (r.burned ?? "0").toString(),
      burnedFormatted: formatUnits(r.burned ?? "0", CRA_DECIMALS, 0),
      payoutUsdc: usd6(r.payout),
    })),
    recent: recent.rows.map((r) => ({
      kind: r.kind,
      blockNumber: Number(r.block_number),
      timestamp: Number(r.timestamp),
      txHash: hex(r.tx_hash),
      from: hex(r.from),
      to: hex(r.to),
      amount: r.amount,
      amountFormatted: r.kind === "burn" ? formatUnits(r.amount, CRA_DECIMALS, 0) : usd6(r.amount),
    })),
  };
}


// ---------------------------------------------------------------------------
// FX: EURC <-> USDC as actually executed on Arc
// ---------------------------------------------------------------------------

export interface FxSummary {
  /** e.g. "EURC/USDC". The quote side is always USDC. */
  pair: string;
  symbol: string;
  decimals: number;
  /** Last executed rate, USDC per whole base unit. */
  last: { rate: number; direction: string; at: number; sizeBase: string; sizeUsdc: string } | null;
  /** `low`/`high` are the 5th and 95th percentile: the range most of the volume executed in, without a single odd fill setting it. */
  window: { minutes: number; trades: number; vwap: number | null; min: number | null; max: number | null; low: number | null; high: number | null; volumeBase: string; volumeUsdc: string };
  /** Executed rate by trade size in USDC: what a conversion of that size actually got. */
  bySize: Array<{ bucket: string; trades: number; vwap: number | null; spreadBps: number | null }>;
  venues: Array<{ venue: string | null; trades: number; vwap: number | null; volumeUsdc: string }>;
  series: Array<{ t: number; vwap: number; trades: number; volumeUsdc: string }>;
}

// Buckets by the USDC value of the trade, so they mean the same thing for any token.
const bucketLabel = "CASE WHEN usdc_amount < 100000000 THEN '<100' WHEN usdc_amount < 1000000000 THEN '100-1k' WHEN usdc_amount < 10000000000 THEN '1k-10k' ELSE '10k+' END";
const BUCKETS = ["<100", "100-1k", "1k-10k", "10k+"];

/**
 * Executed prices for one pair against USDC, read from the swaps the collector saw on chain.
 * `decimals` is the base token's: rates are per whole unit, so an 18-decimal token is scaled here.
 */
export async function fxSummary(db: Db, windowMinutes = 60, symbol = "EURC", decimals = 6): Promise<FxSummary> {
  const since = `extract(epoch FROM now()) - ${windowMinutes * 60}`;
  // USDC per whole base unit = raw usdc / raw base * 10^(decimals - 6).
  const scale = `* 1e${decimals - 6}`;
  const rate = `sum(usdc_amount) / nullif(sum(eurc_amount), 0) ${scale}`;
  const where = `base_symbol = $1 AND "timestamp" > ${since}`;
  const [last, agg, bySize, venues, series] = await Promise.all([
    db.query<{ rate: number; direction: string; timestamp: string; eurc_amount: string; usdc_amount: string }>(
      'SELECT rate, direction, "timestamp", eurc_amount, usdc_amount FROM fx_trades WHERE base_symbol = $1 ORDER BY "timestamp" DESC LIMIT 1',
      [symbol],
    ),
    db.query<{ n: string; vwap: number | null; mn: number | null; mx: number | null; lo: number | null; hi: number | null; vbase: string | null; vusdc: string | null }>(
      `SELECT count(*) AS n, ${rate} AS vwap, min(rate) AS mn, max(rate) AS mx,
              percentile_cont(0.05) WITHIN GROUP (ORDER BY rate) AS lo,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY rate) AS hi,
              sum(eurc_amount) AS vbase, sum(usdc_amount) AS vusdc
       FROM fx_trades WHERE ${where}`,
      [symbol],
    ),
    db.query<{ bucket: string; n: string; vwap: number | null }>(
      `SELECT ${bucketLabel} AS bucket, count(*) AS n, ${rate} AS vwap
       FROM fx_trades WHERE ${where} GROUP BY 1`,
      [symbol],
    ),
    db.query<{ venue: Buffer | null; n: string; vwap: number | null; vusdc: string | null }>(
      `SELECT venue, count(*) AS n, ${rate} AS vwap, sum(usdc_amount) AS vusdc
       FROM fx_trades WHERE ${where} GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
      [symbol],
    ),
    db.query<{ t: string; vwap: number; n: string; vusdc: string }>(
      `SELECT ("timestamp" / 300) * 300 AS t, ${rate} AS vwap, count(*) AS n, sum(usdc_amount) AS vusdc
       FROM fx_trades WHERE ${where} GROUP BY 1 ORDER BY 1`,
      [symbol],
    ),
  ]);
  const l = last.rows[0];
  const a = agg.rows[0]!;
  const reference = a.vwap;
  return {
    pair: `${symbol}/USDC`,
    symbol,
    decimals,
    last: l
      ? { rate: Number(l.rate), direction: l.direction, at: Number(l.timestamp), sizeBase: formatUnits(l.eurc_amount, BigInt(decimals)), sizeUsdc: usd6(l.usdc_amount) }
      : null,
    window: {
      minutes: windowMinutes,
      trades: Number(a.n),
      vwap: a.vwap === null ? null : Number(a.vwap),
      min: a.mn === null ? null : Number(a.mn),
      max: a.mx === null ? null : Number(a.mx),
      low: a.lo === null ? null : Number(a.lo),
      high: a.hi === null ? null : Number(a.hi),
      volumeBase: formatUnits(a.vbase ?? "0", BigInt(decimals)),
      volumeUsdc: usd6(a.vusdc),
    },
    bySize: bySize.rows
      .map((r) => ({
        bucket: r.bucket,
        trades: Number(r.n),
        vwap: r.vwap === null ? null : Number(r.vwap),
        // How far this size executed from the window's volume-weighted rate, in basis points.
        spreadBps: r.vwap === null || reference === null ? null : Math.round(((Number(r.vwap) - Number(reference)) / Number(reference)) * 10_000),
      }))
      .sort((x, y) => BUCKETS.indexOf(x.bucket) - BUCKETS.indexOf(y.bucket)),
    venues: venues.rows.map((r) => ({ venue: hex(r.venue), trades: Number(r.n), vwap: r.vwap === null ? null : Number(r.vwap), volumeUsdc: usd6(r.vusdc) })),
    series: series.rows.map((r) => ({ t: Number(r.t), vwap: Number(r.vwap), trades: Number(r.n), volumeUsdc: usd6(r.vusdc) })),
  };
}


export interface SelftestRun {
  at: number;
  ok: boolean;
  latencyMs: number | null;
  amountUsdc: string;
  /** Gateway transfer id, then the on-chain transaction once the batch lands. */
  settlementId: string | null;
  settlementTx: string | null;
  receiptSigned: boolean;
}
export interface SelftestSummary {
  /** Says what this is, so nobody reads our own payments as customers. */
  note: string;
  agent: string | null;
  last: SelftestRun | null;
  lastNotCharged: { at: number; ok: boolean } | null;
  last24h: { runs: number; ok: number; failed: number; avgLatencyMs: number | null };
  recent: SelftestRun[];
}

/**
 * The rail paying itself on a timer. Read from the rail's own ledger, which lives in the same
 * database. The table only exists once the self-test has run, so its absence is "no data yet".
 */
export async function selftestSummary(db: Db, agentId = "selftest"): Promise<SelftestSummary> {
  const note = "Our own wallet buying our own endpoint every hour, to prove the rail is alive. Not customer activity.";
  const empty: SelftestSummary = { note, agent: null, last: null, lastNotCharged: null, last24h: { runs: 0, ok: 0, failed: 0, avgLatencyMs: null }, recent: [] };
  const exists = await db.query<{ t: string | null }>("SELECT to_regclass('public.rail_payments')::text AS t");
  if (!exists.rows[0]?.t) return empty;
  const paid = "url LIKE '%/v1/paid/fees/estimate%'";
  const [runs, agg, notCharged] = await Promise.all([
    db.query<{ at: string; status: string; latency_ms: number | null; amount_usdc6: string; tx_hash: string | null; settlement_tx: string | null; payer: string | null; signed: boolean }>(
      `SELECT extract(epoch FROM at)::bigint AS at, status, latency_ms, amount_usdc6, tx_hash, settlement_tx, payer, (meta -> 'attestation' ->> 'signature') IS NOT NULL AS signed
       FROM rail_payments WHERE agent_id = $1 AND ${paid} ORDER BY at DESC LIMIT 24`,
      [agentId],
    ),
    db.query<{ n: string; ok: string; lat: string | null }>(
      `SELECT count(*) AS n, count(*) FILTER (WHERE status = 'settled') AS ok, avg(latency_ms) FILTER (WHERE status = 'settled') AS lat
       FROM rail_payments WHERE agent_id = $1 AND ${paid} AND at > now() - interval '24 hours'`,
      [agentId],
    ),
    db.query<{ at: string; status: string }>(
      "SELECT extract(epoch FROM at)::bigint AS at, status FROM rail_payments WHERE agent_id = $1 AND url LIKE '%/v1/paid/selftest/fail%' ORDER BY at DESC LIMIT 1",
      [agentId],
    ),
  ]);
  const toRun = (r: (typeof runs.rows)[number]): SelftestRun => ({
    at: Number(r.at), ok: r.status === "settled", latencyMs: r.latency_ms, amountUsdc: usd6Exact(r.amount_usdc6), settlementId: r.tx_hash, settlementTx: r.settlement_tx, receiptSigned: r.signed,
  });
  const a = agg.rows[0]!;
  const nc = notCharged.rows[0];
  return {
    note,
    agent: runs.rows[0]?.payer ?? null,
    last: runs.rows[0] ? toRun(runs.rows[0]) : null,
    // "quoted" is how the ledger records a signed payment that was never settled because the handler failed.
    lastNotCharged: nc ? { at: Number(nc.at), ok: nc.status === "quoted" } : null,
    last24h: { runs: Number(a.n), ok: Number(a.ok), failed: Number(a.n) - Number(a.ok), avgLatencyMs: a.lat === null ? null : Math.round(Number(a.lat)) },
    recent: runs.rows.map(toRun),
  };
}

export interface SettlementRow {
  rail: "direct" | "gateway" | "base";
  network: string;
  outcome: "settled" | "failed" | "not_charged";
  payer: string | null;
  payTo: string;
  amountUsdc6: string;
  tx: string | null;
  reason: string | null;
  route: string | null;
}

/** Written as each payment ends. The unique index on tx makes a repeated report a no-op. */
export async function recordSettlement(db: Db, r: SettlementRow): Promise<void> {
  await db.query(
    `INSERT INTO settlements (rail, network, outcome, payer, pay_to, amount_usdc6, tx, reason, route)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
    [r.rail, r.network, r.outcome, r.payer?.toLowerCase() ?? null, r.payTo.toLowerCase(), r.amountUsdc6, r.tx, r.reason, r.route],
  );
}

/** Whose wallet paid. Ours are named as ours, so the page can never pass our own tests off as customers. */
export type PayerKind = "self-test" | "ours" | "external";
export interface SettlementView {
  at: number;
  rail: string;
  outcome: string;
  /** Shortened: the full address is in the transaction for anyone who follows the hash. */
  payer: string | null;
  who: PayerKind;
  amountUsdc: string;
  tx: string | null;
  route: string | null;
  reason: string | null;
}
interface Tally {
  settled: number;
  failed: number;
  notCharged: number;
  volumeUsdc: string;
  payers: number;
}
export interface SettlementsSummary {
  note: string;
  since: number | null;
  all: Tally;
  /** The same counts without our own wallets: the only figure that says anything about usage. */
  external: Tally;
  recent: SettlementView[];
}

const shortAddr = (a: string | null): string | null => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : null);

export async function settlementsSummary(db: Db, ownPayers: readonly string[], limit = 50): Promise<SettlementsSummary> {
  const note = "Every payment our paid routes verified, and how it ended. Payments from our own wallets are marked as ours: the hourly self-test is most of them.";
  const zero: Tally = { settled: 0, failed: 0, notCharged: 0, volumeUsdc: "0", payers: 0 };
  const tables = await db.query<{ s: string | null; l: string | null }>("SELECT to_regclass('public.settlements')::text AS s, to_regclass('public.rail_payments')::text AS l");
  if (!tables.rows[0]?.s) return { note, since: null, all: zero, external: zero, recent: [] };
  const selftest = tables.rows[0].l
    ? (await db.query<{ payer: string }>("SELECT DISTINCT lower(payer) AS payer FROM rail_payments WHERE agent_id = 'selftest' AND payer IS NOT NULL")).rows.map((r) => r.payer)
    : [];
  const ours = [...new Set([...selftest, ...ownPayers.map((a) => a.toLowerCase())])];
  const tally = `count(*) FILTER (WHERE outcome = 'settled') AS settled, count(*) FILTER (WHERE outcome = 'failed') AS failed,
    count(*) FILTER (WHERE outcome = 'not_charged') AS not_charged, coalesce(sum(amount_usdc6) FILTER (WHERE outcome = 'settled'), 0) AS volume,
    count(DISTINCT payer) FILTER (WHERE outcome = 'settled') AS payers`;
  type T = { settled: string; failed: string; not_charged: string; volume: string; payers: string };
  const [all, ext, first, rows] = await Promise.all([
    db.query<T>(`SELECT ${tally} FROM settlements`),
    db.query<T>(`SELECT ${tally} FROM settlements WHERE payer IS NULL OR payer <> ALL($1::text[])`, [ours]),
    db.query<{ at: string | null }>("SELECT extract(epoch FROM min(at))::bigint AS at FROM settlements"),
    db.query<{ at: string; rail: string; outcome: string; payer: string | null; amount_usdc6: string; tx: string | null; route: string | null; reason: string | null }>(
      "SELECT extract(epoch FROM at)::bigint AS at, rail, outcome, payer, amount_usdc6, tx, route, reason FROM settlements ORDER BY at DESC, id DESC LIMIT $1",
      [limit],
    ),
  ]);
  const toTally = (t: T): Tally => ({ settled: Number(t.settled), failed: Number(t.failed), notCharged: Number(t.not_charged), volumeUsdc: usd6Exact(t.volume), payers: Number(t.payers) });
  return {
    note,
    since: first.rows[0]?.at ? Number(first.rows[0].at) : null,
    all: toTally(all.rows[0]!),
    external: toTally(ext.rows[0]!),
    recent: rows.rows.map((r) => ({
      at: Number(r.at),
      rail: r.rail,
      outcome: r.outcome,
      payer: shortAddr(r.payer),
      who: r.payer && selftest.includes(r.payer) ? "self-test" : r.payer && ours.includes(r.payer) ? "ours" : "external",
      amountUsdc: usd6Exact(r.amount_usdc6),
      tx: r.tx,
      route: r.route,
      reason: r.reason,
    })),
  };
}
