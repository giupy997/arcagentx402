import { statfs } from "node:fs/promises";
import type { Alerter } from "../alerts.js";
import type { CollectorConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { Logger } from "../log.js";
import type { RpcPool } from "../rpc/pool.js";
import type { RpcBlock } from "../rpc/types.js";
import type { RuntimeState } from "../state.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Every probeIntervalMs, asks EVERY endpoint for latest/finalized/safe and records a head_observations
 * row per endpoint. This is (a) the per-provider lag/latency dataset for launch day, (b) the input
 * for the pool's lag-aware routing, and (c) where lag/stall alerts are evaluated.
 */
export class ProbeWorker {
  private stopped = false;
  private done: Promise<void> | null = null;
  constructor(
    private readonly cfg: CollectorConfig,
    private readonly db: Db,
    private readonly pool: RpcPool,
    private readonly state: RuntimeState,
    private readonly alerts: Alerter,
    private readonly log: Logger,
  ) {}

  start(): void {
    this.done = this.loop().catch((err) => this.log.error({ err }, "probe crashed"));
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.done;
  }

  async probeOnce(): Promise<void> {
    const now = new Date();
    await Promise.all(
      this.pool.endpoints
        .filter((e) => !e.disabledReason)
        .map(async (e) => {
          const started = Date.now();
          try {
            const r = await this.pool.batch<RpcBlock | null>(
              [
                { method: "eth_getBlockByNumber", params: ["latest", false] },
                { method: "eth_getBlockByNumber", params: ["finalized", false] },
                { method: "eth_getBlockByNumber", params: ["safe", false] },
              ],
              { only: e.url, maxAttempts: 1 },
            );
            const num = (o: (typeof r.outcomes)[number]): number | null => (o.ok && o.result ? Number(BigInt(o.result.number)) : null);
            const latest = num(r.outcomes[0]!);
            const latestTs = r.outcomes[0]!.ok && r.outcomes[0]!.result ? Number(BigInt(r.outcomes[0]!.result.timestamp)) : null;
            if (latest !== null) this.pool.recordHead(e.url, latest);
            await this.db.query(
              "INSERT INTO head_observations (observed_at, endpoint, latest, finalized, safe, latest_timestamp, rtt_ms) VALUES ($1,$2,$3,$4,$5,$6,$7)",
              [now, e.name, latest, num(r.outcomes[1]!), num(r.outcomes[2]!), latestTs, r.durationMs],
            );
          } catch (err) {
            await this.db.query("INSERT INTO head_observations (observed_at, endpoint, rtt_ms, error) VALUES ($1,$2,$3,$4)", [
              now,
              e.name,
              Date.now() - started,
              err instanceof Error ? err.message.slice(0, 300) : String(err),
            ]);
          }
        }),
    );
    const best = this.pool.bestKnownHead;
    if (best !== null && (this.state.chainHead === null || best > this.state.chainHead)) {
      this.state.chainHead = best;
      this.state.chainHeadAt = Date.now();
    }
    await this.evaluateAlerts();
  }

  private async evaluateAlerts(): Promise<void> {
    const lag = this.state.lag();
    // Startup grace: a fresh process is expected to be behind; alert only if it is still behind after 2 minutes.
    const catchingUpSinceStart = Date.now() - this.state.startedAt < 120_000;
    if (lag !== null && lag > this.cfg.lagAlertBlocks && !catchingUpSinceStart) await this.alerts.raise("lag", `collector is ${lag} blocks behind head ${this.state.chainHead}`);
    else if (lag !== null) await this.alerts.clear("lag", `lag ${lag}`);

    const sinceIngest = this.state.lastIngestAt ? (Date.now() - this.state.lastIngestAt) / 1000 : (Date.now() - this.state.startedAt) / 1000;
    const chainMoving = this.state.chainHeadAt !== null && Date.now() - this.state.chainHeadAt < this.cfg.stallAlertSeconds * 1000;
    if (sinceIngest > this.cfg.stallAlertSeconds && chainMoving) await this.alerts.raise("stall", `no block ingested for ${Math.round(sinceIngest)}s while chain head moves`);
    else await this.alerts.clear("stall");
    // The alert alone once sat unread for a day while the head worker hung without crashing.
    if (this.cfg.stallRestartSeconds > 0 && sinceIngest > this.cfg.stallRestartSeconds && chainMoving) {
      this.log.fatal({ sinceIngestSeconds: Math.round(sinceIngest) }, "ingestion is stuck while the chain moves: exiting so the supervisor starts a fresh process");
      process.exitCode = 1;
      process.kill(process.pid, "SIGTERM");
    }

    if (!this.pool.healthy()) await this.alerts.raise("rpc_down", "every RPC endpoint is failing or disabled");
    else await this.alerts.clear("rpc_down");

    if (this.state.gapsOpen > 50) await this.alerts.raise("gaps", `${this.state.gapsOpen} gap ranges open`);
    else await this.alerts.clear("gaps");

    try {
      const st = await statfs(this.cfg.diskPath);
      const freeGb = (Number(st.bavail) * Number(st.bsize)) / 1e9;
      this.state.diskFreeGb = Math.round(freeGb * 10) / 10;
      if (freeGb < this.cfg.diskAlertGb) await this.alerts.raise("disk", `${this.state.diskFreeGb} GB free on ${this.cfg.diskPath} (alert below ${this.cfg.diskAlertGb} GB)`);
      else await this.alerts.clear("disk");
    } catch {
      /* statfs unsupported: no disk alerting */
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.probeOnce();
      } catch (err) {
        this.log.error({ err }, "probe error");
      }
      await sleep(this.cfg.probeIntervalMs);
    }
  }
}
