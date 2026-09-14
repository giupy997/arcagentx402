import { createServer, type Server } from "node:http";
import type { Alerter } from "./alerts.js";
import type { CollectorConfig } from "./config.js";
import type { Logger } from "./log.js";
import type { RuntimeState } from "./state.js";

export function buildStatus(cfg: CollectorConfig, state: RuntimeState, alerts: Alerter) {
  const lag = state.lag();
  const stalled = state.lastIngestAt !== null && Date.now() - state.lastIngestAt > cfg.stallAlertSeconds * 1000 && state.chainHeadAt !== null && Date.now() - state.chainHeadAt < cfg.stallAlertSeconds * 1000;
  const ok = state.pool.healthy() && (lag === null || lag <= cfg.lagAlertBlocks) && !stalled;
  return {
    ok,
    network: cfg.network,
    chainId: cfg.chainId,
    genesisHash: state.genesisHash,
    uptimeSeconds: Math.round((Date.now() - state.startedAt) / 1000),
    head: { chain: state.chainHead, ingested: state.headCursor, lag, start: state.headStart, chainHeadAgeMs: state.chainHeadAt ? Date.now() - state.chainHeadAt : null },
    lastIngestAgeMs: state.lastIngestAt ? Date.now() - state.lastIngestAt : null,
    counters: { blocksIngested: state.blocksIngested, txsIngested: state.txsIngested, errors: state.errors },
    backfill: state.backfill,
    gapsOpen: state.gapsOpen,
    revertsPending: state.revertsPending,
    alertsActive: alerts.activeKeys(),
    endpoints: state.pool.snapshot(),
  };
}

function metricsText(cfg: CollectorConfig, state: RuntimeState): string {
  const lines: string[] = [];
  const g = (name: string, value: number | null, labels = "") => {
    if (value === null) return;
    lines.push(`# TYPE ${name} gauge`, `${name}{network="${cfg.network}"${labels}} ${value}`);
  };
  g("arc_collector_chain_head", state.chainHead);
  g("arc_collector_ingested_head", state.headCursor);
  g("arc_collector_lag_blocks", state.lag());
  g("arc_collector_blocks_ingested_total", state.blocksIngested);
  g("arc_collector_txs_ingested_total", state.txsIngested);
  g("arc_collector_gaps_open", state.gapsOpen);
  g("arc_collector_reverts_pending", state.revertsPending);
  g("arc_collector_backfill_cursor", state.backfill?.cursor ?? null);
  g("arc_collector_backfill_target", state.backfill?.target ?? null);
  g("arc_collector_last_ingest_age_seconds", state.lastIngestAt ? (Date.now() - state.lastIngestAt) / 1000 : null);
  for (const e of state.pool.snapshot()) {
    const l = `,endpoint="${e.name}"`;
    g("arc_collector_rpc_head", e.lastHead, l);
    g("arc_collector_rpc_latency_ewma_ms", Math.round(e.latencyEwmaMs), l);
    g("arc_collector_rpc_failures_total", e.totalFailures, l);
    g("arc_collector_rpc_calls_total", e.totalCalls, l);
    g("arc_collector_rpc_in_cooldown", e.inCooldown ? 1 : 0, l);
  }
  return lines.join("\n") + "\n";
}

export function startHealthServer(cfg: CollectorConfig, state: RuntimeState, alerts: Alerter, log: Logger): Server {
  const server = createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      const s = buildStatus(cfg, state, alerts);
      res.writeHead(s.ok ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify(s, null, 2));
    } else if (req.url === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      res.end(metricsText(cfg, state));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(cfg.healthPort, () => log.info({ port: cfg.healthPort }, "health server listening"));
  return server;
}
