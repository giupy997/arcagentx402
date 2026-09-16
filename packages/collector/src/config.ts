import { z } from "zod";

/**
 * Chain IDs. Testnet verified live on 2026-09-14 (eth_chainId on rpc.testnet.arc.io = 0x4cef52).
 * Mainnet: docs.arc.io does not publish mainnet parameters yet (checked 2026-09-14). 5042 comes
 * from viem's `arc` chain definition and from the pre-launch Blockdaemon endpoint; it MUST be
 * confirmed on https://docs.arc.io/arc/references/connect-to-arc at launch. The collector asserts
 * the configured id against eth_chainId of every endpoint at startup and refuses to run otherwise.
 */
export const DEFAULT_CHAIN_IDS = { testnet: 5042002, mainnet: 5042 } as const;

export const DEFAULT_RPC_URLS = {
  testnet: [
    "https://rpc.testnet.arc.io",
    "https://rpc.drpc.testnet.arc.io",
    "https://rpc.quicknode.testnet.arc.io",
    "https://rpc.blockdaemon.testnet.arc.io",
  ],
  // Mainnet public endpoints are not published yet; set ARC_RPC_URLS explicitly.
  mainnet: [] as string[],
} as const;

/**
 * systemd EnvironmentFile does not strip trailing comments, so `KEY=0  # note` arrives as "0  # note".
 * Cut at the first " #" and trim, otherwise a commented-out flag silently reads as enabled.
 */
const clean = (v: string | undefined): string | undefined => {
  if (v === undefined) return undefined;
  const cut = v.replace(/\s+#.*$/, "").trim();
  return cut.length > 0 ? cut : undefined;
};

const csv = (s: string | undefined) =>
  (clean(s) ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const intEnv = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      const c = clean(v);
      return c === undefined ? def : Number(c);
    })
    .pipe(z.number().int().nonnegative());

const boolEnv = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      const c = clean(v);
      return c === undefined ? def : !["0", "false", "no", "off"].includes(c.toLowerCase());
    });

const EnvSchema = z.object({
  ARC_NETWORK: z.string().optional().transform((v) => clean(v) ?? "testnet").pipe(z.enum(["testnet", "mainnet"])),
  ARC_CHAIN_ID: z.string().optional(),
  ARC_RPC_URLS: z.string().optional(),
  ALCHEMY_ARC_URL: z.string().optional(),
  DATABASE_URL: z.string().min(1),
  COLLECTOR_START_BLOCK: intEnv(0),
  COLLECTOR_CONCURRENCY: intEnv(4),
  COLLECTOR_BATCH_BLOCKS: intEnv(20),
  COLLECTOR_BACKFILL_CONCURRENCY: intEnv(2),
  COLLECTOR_BACKFILL_HISTORY: boolEnv(true),
  COLLECTOR_HEAD_POLL_MS: intEnv(250),
  COLLECTOR_PROBE_INTERVAL_MS: intEnv(5000),
  COLLECTOR_GAP_SCAN_INTERVAL_MS: intEnv(600_000),
  COLLECTOR_LAG_ALERT_BLOCKS: intEnv(200),
  COLLECTOR_STALL_ALERT_SECONDS: intEnv(60),
  COLLECTOR_HEALTH_PORT: intEnv(8790),
  COLLECTOR_ENRICH_REVERTS: boolEnv(true),
  COLLECTOR_ENRICH_CODE: boolEnv(true),
  COLLECTOR_RAW_MODE: z.string().optional().transform((v) => clean(v) ?? "compact").pipe(z.enum(["full", "compact"])),
  COLLECTOR_MODE: z.string().optional().transform((v) => clean(v) ?? "full").pipe(z.enum(["full", "light"])),
  COLLECTOR_DISK_PATH: z.string().default("/"),
  COLLECTOR_DISK_ALERT_GB: intEnv(40),
  COLLECTOR_RPC_TIMEOUT_MS: intEnv(15_000),
  COLLECTOR_ENDPOINT_LAG_TOLERANCE: intEnv(20),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
});

export interface CollectorConfig {
  readonly network: "testnet" | "mainnet";
  readonly chainId: number;
  readonly rpcUrls: readonly string[];
  readonly databaseUrl: string;
  readonly startBlock: number;
  readonly concurrency: number;
  readonly batchBlocks: number;
  readonly backfillConcurrency: number;
  /** Backfill [0, start-1] when the collector starts above genesis. Keep ON for mainnet. */
  readonly backfillHistory: boolean;
  readonly headPollMs: number;
  readonly probeIntervalMs: number;
  readonly gapScanIntervalMs: number;
  readonly lagAlertBlocks: number;
  readonly stallAlertSeconds: number;
  readonly healthPort: number;
  readonly enrichReverts: boolean;
  readonly enrichCode: boolean;
  /**
   * full: tx raw and receipt raw stored verbatim (calldata and logs duplicated in raw + columns).
   * compact: raw stored without `input` (kept in transactions.input) and without `logs` (kept in logs table).
   * Both are lossless; compact is ~2x smaller on disk.
   */
  readonly rawMode: "full" | "compact";
  /**
   * full: blocks + transactions + receipts + logs + deploys + reverts (~12-16 GB/day at testnet density).
   * light: blocks, per-block stats by operation, deploys, head observations (~0.4 GB/day). No tx/receipt/log rows.
   */
  readonly mode: "full" | "light";
  /** Filesystem path whose free space is watched (the Postgres data volume). */
  readonly diskPath: string;
  readonly diskAlertGb: number;
  readonly rpcTimeoutMs: number;
  readonly endpointLagTolerance: number;
  readonly telegram: { botToken: string; chatId: string } | null;
  readonly logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CollectorConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const e = parsed.data;
  const chainIdRaw = clean(e.ARC_CHAIN_ID);
  const chainId = chainIdRaw ? Number(chainIdRaw) : DEFAULT_CHAIN_IDS[e.ARC_NETWORK];
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error(`ARC_CHAIN_ID invalid: ${e.ARC_CHAIN_ID}`);
  const rpcUrls = [...csv(e.ARC_RPC_URLS)];
  if (rpcUrls.length === 0) rpcUrls.push(...DEFAULT_RPC_URLS[e.ARC_NETWORK]);
  const alchemy = clean(e.ALCHEMY_ARC_URL);
  if (alchemy) rpcUrls.push(alchemy);
  if (rpcUrls.length === 0) throw new Error("No RPC endpoints configured (ARC_RPC_URLS)");
  for (const u of rpcUrls) {
    if (!/^https?:\/\//.test(u)) throw new Error(`RPC url must be http(s): ${u}`);
  }
  if (e.COLLECTOR_BATCH_BLOCKS < 1 || e.COLLECTOR_BATCH_BLOCKS > 100) throw new Error("COLLECTOR_BATCH_BLOCKS must be 1..100");
  if (e.COLLECTOR_CONCURRENCY < 1) throw new Error("COLLECTOR_CONCURRENCY must be >= 1");
  return {
    network: e.ARC_NETWORK,
    chainId,
    rpcUrls,
    databaseUrl: clean(e.DATABASE_URL)!,
    startBlock: e.COLLECTOR_START_BLOCK,
    concurrency: e.COLLECTOR_CONCURRENCY,
    batchBlocks: e.COLLECTOR_BATCH_BLOCKS,
    backfillConcurrency: e.COLLECTOR_BACKFILL_CONCURRENCY,
    backfillHistory: e.COLLECTOR_BACKFILL_HISTORY,
    headPollMs: e.COLLECTOR_HEAD_POLL_MS,
    probeIntervalMs: e.COLLECTOR_PROBE_INTERVAL_MS,
    gapScanIntervalMs: e.COLLECTOR_GAP_SCAN_INTERVAL_MS,
    lagAlertBlocks: e.COLLECTOR_LAG_ALERT_BLOCKS,
    stallAlertSeconds: e.COLLECTOR_STALL_ALERT_SECONDS,
    healthPort: e.COLLECTOR_HEALTH_PORT,
    enrichReverts: e.COLLECTOR_ENRICH_REVERTS,
    enrichCode: e.COLLECTOR_ENRICH_CODE,
    rawMode: e.COLLECTOR_RAW_MODE,
    mode: e.COLLECTOR_MODE,
    diskPath: clean(e.COLLECTOR_DISK_PATH) ?? "/",
    diskAlertGb: e.COLLECTOR_DISK_ALERT_GB,
    rpcTimeoutMs: e.COLLECTOR_RPC_TIMEOUT_MS,
    endpointLagTolerance: e.COLLECTOR_ENDPOINT_LAG_TOLERANCE,
    telegram: clean(e.TELEGRAM_BOT_TOKEN) && clean(e.TELEGRAM_CHAT_ID) ? { botToken: clean(e.TELEGRAM_BOT_TOKEN)!, chatId: clean(e.TELEGRAM_CHAT_ID)! } : null,
    logLevel: e.LOG_LEVEL,
  };
}

/** Redact API keys in provider URLs for logs (…/v2/<key>). */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/");
    const masked = parts.map((p) => (p.length >= 16 ? p.slice(0, 4) + "…" : p)).join("/");
    return `${u.protocol}//${u.host}${masked}`;
  } catch {
    return url;
  }
}
