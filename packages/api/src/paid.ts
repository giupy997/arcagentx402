import type { Hono } from "hono";
import type { Logger } from "pino";
import { createSeller } from "@cra-agent/seller";
import type { Db } from "./db.js";
import { deployStats, feeEstimate, feeSummary, fxSummary, recentDeploys, rpcStatus } from "./queries.js";
import { PAID_ROUTES, type QueryParam } from "./routes.js";

/** The query a route takes, as JSON Schema, for the discovery catalogue. */
function querySchema(params: readonly QueryParam[]): Record<string, unknown> {
  return {
    type: "object",
    properties: Object.fromEntries(params.map((p) => [p.name, { type: p.type, description: p.description, ...(p.example === undefined ? {} : { example: p.example })}])),
    required: [],
  };
}

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
  // A second rail on Base, only when the credentials for it are configured. It exists so the
  // discovery catalogue, which is filled by the facilitator that settles, can list these routes:
  // no facilitator catalogues Arc today. The Arc price stays exactly the same.
  const cdpKeyId = process.env.CDP_API_KEY_ID;
  const cdpKeySecret = process.env.CDP_API_KEY_SECRET;
  // An open facilitator needs no credentials, so either of the two switches the rail on.
  const discoveryFacilitator = process.env.DISCOVERY_FACILITATOR_URL;
  const basePayTo = process.env.BASE_SELLER_ADDRESS ?? sellerAddress;
  const shared = { payTo: basePayTo, iconUrl: "https://cra-agent.tech/brand/favicon-32.png", tags: ["arc", "chain-data", "fx", "gas"] };
  const discovery =
    cdpKeyId && cdpKeySecret
      ? { ...shared, cdpKeyId, cdpKeySecret }
      : discoveryFacilitator
        ? { ...shared, facilitatorUrl: discoveryFacilitator }
        : undefined;

  // Priced from the shared catalogue, so the OpenAPI document and the 402 always agree.
  const seller = createSeller({
    sellerAddress,
    network: network === "mainnet" ? "arc" : "arcTestnet",
    serviceName: "CRA AGENT data",
    ...(discovery ? { discovery } : {}),
  });
  for (const r of PAID_ROUTES) {
    seller.route(`GET ${r.path}`, r.price, {
      description: r.description,
      ...(r.preview === undefined ? {} : { preview: r.preview }),
      ...(r.params ? { inputSchema: querySchema(r.params) } : {}),
    });
  }
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
  log.info({ seller: sellerAddress, network: seller.network, routes: Object.keys(seller.routes).length, discovery: discovery ? `${basePayTo} via ${discoveryFacilitator ?? "coinbase"}` : "off" }, "paid endpoints mounted");
}
