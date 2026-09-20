import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { createPool } from "./db.js";
import { buildOpenApi } from "./openapi.js";
import { PAID_ROUTES } from "./routes.js";
import { activity, deployStats, feeEstimate, feeSummary, fxSummary, networkSummary, recentDeploys, rpcStatus, selftestSummary, tokenSummary } from "./queries.js";
import { mountPaidRoutes } from "./paid.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info", base: { app: "cra-agent-api" } });
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
const PORT = Number(process.env.API_PORT ?? 8791);
const NETWORK = process.env.ARC_NETWORK ?? "testnet";
const CHAIN_ID = Number(process.env.ARC_CHAIN_ID ?? (NETWORK === "mainnet" ? 5042 : 5042002));
const here = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = process.env.WEB_DIR ?? join(here, "..", "..", "web", "dist");

const db = createPool(DATABASE_URL);
const app = new Hono();
/** Published in the OpenAPI document; kept in step with the package version. */
const API_VERSION = "0.1.0";
// A browser can only pay if it may send the payment header and read the two the protocol answers with.
app.use("*", cors({ origin: "*", allowMethods: ["GET"], allowHeaders: ["PAYMENT-SIGNATURE", "X-PAYMENT", "Content-Type", "Accept"], exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE"] }));

/** Tiny TTL cache: the dashboard polls every few seconds; the DB should not feel it. */
const cache = new Map<string, { at: number; body: unknown }>();
const cached = async <T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.body as T;
  const body = await fn();
  cache.set(key, { at: Date.now(), body });
  return body;
};

app.get("/v1/network", async (c) => c.json(await cached("network", 2000, () => networkSummary(db, NETWORK, CHAIN_ID))));
app.get("/v1/fees", async (c) => {
  const w = Math.min(1440, Math.max(5, Number(c.req.query("window") ?? 60)));
  return c.json(await cached(`fees:${w}`, 5000, () => feeSummary(db, w)));
});
app.get("/v1/fees/estimate", async (c) => {
  const gasRaw = c.req.query("gas") ?? "21000";
  if (!/^\d{1,9}$/.test(gasRaw)) return c.json({ error: "gas must be an integer" }, 400);
  const r = await cached(`estimate:${gasRaw}`, 2000, () => feeEstimate(db, BigInt(gasRaw)));
  return r ? c.json(r) : c.json({ error: "no blocks yet" }, 503);
});
app.get("/v1/activity", async (c) => {
  const w = Math.min(1440, Math.max(5, Number(c.req.query("window") ?? 60)));
  return c.json(await cached(`activity:${w}`, 5000, () => activity(db, w)));
});
app.get("/v1/deploys", async (c) => {
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50)));
  return c.json(await cached(`deploys:${limit}`, 5000, async () => ({ recent: await recentDeploys(db, limit, NETWORK), perHour: await deployStats(db) })));
});
app.get("/v1/rpc", async (c) => c.json(await cached("rpc", 5000, () => rpcStatus(db))));
/** Pairs the collector prices. The base token decimals decide how a rate is scaled. */
const PAIRS: Record<string, number> = { EURC: 6, [process.env.TOKEN_SYMBOL ?? "CRA"]: 18 };
const resolvePair = (q: string | undefined): { symbol: string; decimals: number } => {
  const symbol = (q ?? "EURC").toUpperCase();
  return { symbol, decimals: PAIRS[symbol] ?? 6 };
};
const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS ?? null;
const TOKEN_DISTRIBUTOR = process.env.TOKEN_DISTRIBUTOR ?? null;
app.get("/v1/fx", async (c) => {
  const w = Math.min(1440, Math.max(5, Number(c.req.query("window") ?? 60)));
  const { symbol, decimals } = resolvePair(c.req.query("symbol"));
  const full = await cached(`fx:${symbol}:${w}`, 10_000, () => fxSummary(db, w, symbol, decimals));
  // Free tier: the headline rate and the window, without the size curve or the venue breakdown.
  return c.json({ pair: full.pair, last: full.last, window: full.window, paid: "/v1/paid/fx/execution" });
});
app.get("/v1/token", async (c) =>
  c.json(
    await cached("token", 10_000, async () => {
      const summary = await tokenSummary(db, TOKEN_ADDRESS, TOKEN_DISTRIBUTOR);
      const symbol = summary.token?.symbol;
      if (!symbol) return { ...summary, price: null };
      // The same execution data as /v1/fx, for the project token: real swaps, not a quote.
      const fx = await fxSummary(db, 1440, symbol, summary.token?.decimals ?? 18);
      // The size curve and venue breakdown stay in the paid route; the page shows price, window and shape.
      return { ...summary, price: { pair: fx.pair, last: fx.last, window: fx.window, series: fx.series } };
    }),
  ),
);
/**
 * One call for the landing page: what the collector has read, what the market did, what is on sale.
 * Cached, because it is the most requested thing on the site and none of it changes by the second.
 */
app.get("/v1/selftest", async (c) => c.json(await cached("selftest", 15_000, () => selftestSummary(db))));
app.get("/v1/summary", async (c) =>
  c.json(
    await cached("summary", 15_000, async () => {
      const n = await networkSummary(db, NETWORK, CHAIN_ID);
      const pairs = await Promise.all(
        Object.entries(PAIRS).map(async ([symbol, decimals]) => {
          const fx = await fxSummary(db, 1440, symbol, decimals);
          return { symbol, rate: fx.last?.rate ?? null, trades: fx.window.trades, volumeUsdc: fx.window.volumeUsdc };
        }),
      );
      const prices = PAID_ROUTES.map((r) => Number(r.price.replace("$", "")));
      return {
        network: NETWORK,
        collected: { blocks: n.totals.blocks, transactions: n.totals.transactions, deploys: n.totals.deploys },
        head: { number: n.head?.number ?? null, lagBlocks: n.lagBlocks, lastBlockAgeSeconds: n.collector.lastBlockAgeSeconds },
        pairs,
        forSale: { routes: PAID_ROUTES.length, fromUsd: Math.min(...prices), toUsd: Math.max(...prices) },
        selftest: await selftestSummary(db).then((t) => ({ note: t.note, last: t.last, lastNotCharged: t.lastNotCharged, last24h: t.last24h })),
      };
    }),
  ),
);
app.get("/openapi.json", (c) =>
  c.json(
    buildOpenApi({
      origin: new URL(c.req.url).origin,
      network: NETWORK === "mainnet" ? "eip155:5042" : "eip155:5042002",
      sellerAddress: process.env.SELLER_ADDRESS ?? null,
      usdcAddress: "0x3600000000000000000000000000000000000000",
      version: API_VERSION,
    }),
  ),
);
app.get("/v1/health", async (c) => {
  try {
    const n = await cached("network", 2000, () => networkSummary(db, NETWORK, CHAIN_ID));
    const stale = n.collector.lastBlockAgeSeconds === null || n.collector.lastBlockAgeSeconds > 120;
    return c.json({ ok: !stale, network: NETWORK, chainId: CHAIN_ID, head: n.head?.number ?? null, lastBlockAgeSeconds: n.collector.lastBlockAgeSeconds }, stale ? 503 : 200);
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 503);
  }
});
mountPaidRoutes(app, db, NETWORK, log);

app.onError((err, c) => {
  log.error({ err, path: c.req.path }, "request failed");
  return c.json({ error: "internal error" }, 500);
});

if (existsSync(WEB_DIR)) {
  const rel = WEB_DIR.startsWith(process.cwd()) ? WEB_DIR.slice(process.cwd().length + 1) : WEB_DIR;
  app.use("/*", serveStatic({ root: rel, rewriteRequestPath: (p) => (p === "/dashboard" || p === "/network" ? "/dashboard.html" : p === "/token" ? "/token.html" : p === "/try" ? "/try.html" : p) }));
  log.info({ webDir: WEB_DIR }, "serving web");
} else {
  log.warn({ webDir: WEB_DIR }, "web dist not found: API only");
}

/**
 * Behind Caddy the process is reached over plain HTTP, so every URL the app derives from the
 * request says http://, including the resource URL x402 advertises in its 402 challenge. Buyers
 * and directories read that URL, so the scheme the client actually used is put back here.
 */
const fetchWithRealScheme: typeof app.fetch = (request, ...rest) => {
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (proto !== "https" || !request.url.startsWith("http://")) return app.fetch(request, ...rest);
  return app.fetch(new Request(`https://${request.url.slice("http://".length)}`, request), ...rest);
};

serve({ fetch: fetchWithRealScheme, port: PORT }, (info) => log.info({ port: info.port, network: NETWORK }, "cra-agent api listening"));
