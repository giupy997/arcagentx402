import type { Hono } from "hono";
import type { Logger } from "pino";
import { createSeller } from "@cra-agent/seller";
import type { Db } from "./db.js";
import { deployStats, feeEstimate, feeSummary, fxSummary, recentDeploys, rpcStatus } from "./queries.js";

/**
 * The first paid endpoints on the rail: our own Arc data, priced per call, paid via x402 + Circle Gateway.
 * Enabled only when SELLER_ADDRESS is set; the free /v1 routes stay free.
 */
export function mountPaidRoutes(app: Hono, db: Db, network: string, log: Logger): void {
  const sellerAddress = process.env.SELLER_ADDRESS;
  if (!sellerAddress) {
    log.warn("SELLER_ADDRESS not set: paid endpoints disabled");
    return;
  }
  const seller = createSeller({ sellerAddress, network: network === "mainnet" ? "arc" : "arcTestnet", serviceName: "CRA AGENT data" })
    .route("GET /v1/paid/fees/forecast", "$0.001", { description: "Base fee now and next block, 24h band, utilisation trend, cost per operation type", preview: { hint: "pay $0.001 USDC via x402 to get the forecast; free summary at /v1/fees" } })
    .route("GET /v1/paid/fees/estimate", "$0.0005", { description: "Cost in USDC of a transaction with the given gas at current and next base fee (?gas=21000)" })
    .route("GET /v1/paid/deploys/history", "$0.002", { description: "Recent contract deploys with labels and per-hour history (?limit=200)" })
    .route("GET /v1/paid/rpc/health", "$0.0005", { description: "Per-provider RPC latency, head lag and error rates, last 15 minutes" })
    .route("GET /v1/paid/fx/execution", "$0.001", {
      description: "EURC/USDC on Arc as executed: volume-weighted rate, range, the rate by trade size, and where the volume traded (?window=60)",
      preview: { hint: "pay $0.001 USDC via x402 for the size curve and venue breakdown; the headline rate is free at /v1/fx" },
    })
    .route("GET /v1/paid/selftest/fail", "$0.001", {
      description: "Always fails on purpose. Proves the rule: the payment is only settled when the handler succeeds, so a broken endpoint costs the buyer nothing.",
      preview: { hint: "this route always returns 500 after payment is verified; your payment is never settled" },
    });
  app.use("/v1/paid/*", seller.middleware());

  app.get("/v1/paid/fees/forecast", async (c) => {
    const f = await feeSummary(db, 360);
    const last = f.series.slice(-30);
    const trend = last.length >= 2 ? Number((last[last.length - 1]!.utilization - last[0]!.utilization).toFixed(4)) : 0;
    return c.json({ ...f, series: last, utilizationTrend30m: trend, floorGwei: f.floorGwei, note: "base fee follows an EWMA of utilisation; next-block fee is exact (from the header), beyond that the trend is the signal" });
  });
  app.get("/v1/paid/fees/estimate", async (c) => {
    const gasRaw = c.req.query("gas") ?? "21000";
    if (!/^\d{1,9}$/.test(gasRaw)) return c.json({ error: "gas must be an integer" }, 400);
    return c.json(await feeEstimate(db, BigInt(gasRaw)));
  });
  app.get("/v1/paid/deploys/history", async (c) => {
    const limit = Math.min(1000, Math.max(1, Number(c.req.query("limit") ?? 200)));
    return c.json({ recent: await recentDeploys(db, limit, network), perHour: await deployStats(db) });
  });
  app.get("/v1/paid/rpc/health", async (c) => c.json(await rpcStatus(db)));
  // Executed prices for any pair the collector watches against USDC: ?symbol=EURC (default) or the project token.
  app.get("/v1/paid/fx/execution", async (c) => {
    const w = Math.min(1440, Math.max(5, Number(c.req.query("window") ?? 60)));
    const symbol = (c.req.query("symbol") ?? "EURC").toUpperCase();
    const decimals = symbol === "EURC" ? 6 : 18;
    return c.json(await fxSummary(db, w, symbol, decimals));
  });
  // Deliberately broken, and public: anyone can check that a failed handler is not charged.
  app.get("/v1/paid/selftest/fail", (c) => c.json({ error: "this endpoint always fails on purpose", charged: false }, 500));

  app.get("/v1/paid", (c) => c.json({ seller: seller.sellerAddress, network: seller.network, facilitator: seller.facilitatorUrl, routes: Object.entries(seller.routes).map(([k, v]) => ({ route: k, price: String((Array.isArray(v.accepts) ? v.accepts[0] : v.accepts)?.price), description: v.description ?? null })) }));
  log.info({ seller: sellerAddress, network: seller.network, routes: Object.keys(seller.routes).length }, "paid endpoints mounted");
}
