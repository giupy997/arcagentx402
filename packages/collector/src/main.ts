import { Alerter } from "./alerts.js";
import { loadConfig, redactUrl } from "./config.js";
import { createDb } from "./db/index.js";
import { migrate } from "./db/migrate.js";
import { startHealthServer } from "./health.js";
import { log } from "./log.js";
import { RpcPool } from "./rpc/pool.js";
import { verifyChain } from "./startup.js";
import { RuntimeState } from "./state.js";
import { BackfillWorker } from "./workers/backfill.js";
import { EnrichWorker } from "./workers/enrich.js";
import { HeadWorker } from "./workers/head.js";
import { ProbeWorker } from "./workers/probe.js";
import { ScannerWorker } from "./workers/scanner.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  log.level = cfg.logLevel;
  log.info({ network: cfg.network, chainId: cfg.chainId, mode: cfg.mode, rpcs: cfg.rpcUrls.map(redactUrl), startBlock: cfg.startBlock, concurrency: cfg.concurrency, batchBlocks: cfg.batchBlocks }, "cra-agent collector starting");

  const db = createDb(cfg.databaseUrl, log);
  await migrate(db, cfg.network);

  const alerts = new Alerter(cfg, log);
  const pool = new RpcPool(cfg.rpcUrls, {
    timeoutMs: cfg.rpcTimeoutMs,
    lagTolerance: cfg.endpointLagTolerance,
    log,
    onError: (e) => {
      db.query("INSERT INTO rpc_errors (endpoint, method, code, message, duration_ms, block_number) VALUES ($1,$2,$3,$4,$5,$6)", [e.endpoint, e.method, e.code, e.message.slice(0, 500), e.durationMs, e.blockNumber ?? null]).catch(() => {});
    },
  });
  const state = new RuntimeState(pool);

  try {
    const { genesisHash } = await verifyChain(pool, db, cfg.chainId, log);
    state.genesisHash = genesisHash;
  } catch (err) {
    await alerts.raise("chain_mismatch", (err as Error).message);
    throw err;
  }

  const head = new HeadWorker(cfg, db, pool, state, alerts, log);
  const backfill = new BackfillWorker(cfg, db, pool, state, log);
  const scanner = new ScannerWorker(cfg, db, state, log);
  const probe = new ProbeWorker(cfg, db, pool, state, alerts, log);
  const enrich = new EnrichWorker(cfg, db, pool, state, log);

  await head.init();
  await backfill.init();
  await probe.probeOnce();

  const server = startHealthServer(cfg, state, alerts, log);
  head.start();
  backfill.start();
  scanner.start();
  probe.start();
  enrich.start();
  await alerts.info(`collector started: head cursor ${state.headCursor}, chain head ${state.chainHead}, ${pool.endpoints.filter((e) => !e.disabledReason).length} endpoints`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down: finishing in-flight batches");
    const timer = setTimeout(() => {
      log.error("shutdown timed out, exiting");
      process.exit(1);
    }, 30_000);
    await Promise.all([head.stop(), backfill.stop(), scanner.stop(), probe.stop(), enrich.stop()]);
    server.close();
    await db.end();
    clearTimeout(timer);
    log.info("bye");
    process.exit(process.exitCode ?? 0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (err) => log.error({ err }, "unhandled rejection"));
}

main().catch((err) => {
  log.fatal({ err }, "collector failed to start");
  process.exit(1);
});
