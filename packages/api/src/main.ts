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
import { PAIRS, resolvePair } from "./pairs.js";
import { PAID_ROUTES } from "./routes.js";
import { activity, deployStats, feeEstimate, feeSummary, fxSummary, networkSummary, recentDeploys, rpcStatus, selftestSummary, settlementsSummary, tokenSummary } from "./queries.js";
import { mountFacilitator } from "./facilitator.js";
import { mountLane } from "./lane.js";
import { directPaymentsSummary, directServices } from "./direct-payments.js";
import { labelsFor, labelsSummary, startLabeler } from "./labels.js";
import { mountBazaar } from "./bazaar.js";
import { mountMarket } from "./market.js";
import { mountPaidRoutes } from "./paid.js";
import { usycReader } from "./usyc.js";
import { mountThink } from "./think-runs.js";

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
app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST"], allowHeaders: ["PAYMENT-SIGNATURE", "X-PAYMENT", "Content-Type", "Accept"], exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE"] }));

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
const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS ?? null;
const TOKEN_DISTRIBUTOR = process.env.TOKEN_DISTRIBUTOR ?? null;
app.get("/v1/fx", async (c) => {
  const w = Math.min(1440, Math.max(5, Number(c.req.query("window") ?? 60)));
  const pair = resolvePair(c.req.query("symbol"));
  if (!pair) return c.json({ error: `we do not price that pair. Priced against USDC: ${PAIRS.map((p) => p.symbol).join(", ")}` }, 400);
  const { symbol, decimals } = pair;
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
/** Wallets of ours besides the self-test one, so the status page never counts them as customers. */
const OWN_PAYERS = (process.env.OWN_PAYERS ?? "").split(",").map((a) => a.trim()).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a));
/** What the facilitator next door says about itself: who signs, and how much gas money it has left. */
async function facilitatorHealth(): Promise<{ ok: boolean; signer: string | null; gasUsdc: string | null } | null> {
  const url = process.env.DIRECT_FACILITATOR_URL;
  if (!url) return null;
  try {
    const h = (await (await fetch(`${url.replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(3000) })).json()) as { ok?: boolean; signer?: string; gasBalanceWei?: string };
    // Arc's gas is USDC with 18 decimals; four are plenty to see whether it is running low.
    const gasUsdc = h.gasBalanceWei ? (Number(BigInt(h.gasBalanceWei) / 10n ** 14n) / 1e4).toFixed(4) : null;
    return { ok: h.ok === true, signer: h.signer ?? null, gasUsdc };
  } catch {
    return { ok: false, signer: null, gasUsdc: null };
  }
}
app.get("/v1/settlements", async (c) => c.json(await cached("settlements", 5000, async () => ({ ...(await settlementsSummary(db, OWN_PAYERS)), facilitator: await facilitatorHealth() }))));
app.get("/v1/selftest", async (c) => c.json(await cached("selftest", 15_000, () => selftestSummary(db))));
/** Payments by signed authorization on Arc, from the collector's index. Raw activity, not demand: the answer says why. */
app.get("/v1/payments/direct", async (c) =>
  c.json(
    await cached("direct-payments", 60_000, async () => {
      const f = await facilitatorHealth();
      const labels = new Map<string, string>(f?.signer ? [[f.signer.toLowerCase(), "CRA AGENT facilitator"]] : []);
      return directPaymentsSummary(db, { network: NETWORK === "mainnet" ? "eip155:5042" : "eip155:5042002", labels });
    }),
  ),
);
/** Who is behind an address on Arc, as public sources say it. Free: it is what those sources already publish. */
app.get("/v1/labels", async (c) => c.json(await cached("labels", 60_000, () => labelsSummary(db))));
app.get("/v1/labels/:address", async (c) => {
  const address = c.req.param("address").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) return c.json({ error: "give a 0x address" }, 400);
  const labels = (await labelsFor(db, [Buffer.from(address.slice(2), "hex")])).get(address) ?? [];
  return c.json({ address, labels: labels.map(({ name, role, source, url, detail }) => ({ name, role, source, url, detail })) });
});
/** The known sellers that direct payments reach, by how many payers each has. The base of the usage ranking. */
app.get("/v1/payments/direct/services", async (c) => c.json(await cached("direct-services", 60_000, () => directServices(db, { network: NETWORK === "mainnet" ? "eip155:5042" : "eip155:5042002" }))));
/**
 * One call for the landing page: what the collector has read, what the market did, what is on sale.
 * Cached, because it is the most requested thing on the site and none of it changes by the second.
 */
app.get("/v1/summary", async (c) =>
  c.json(
    await cached("summary", 15_000, async () => {
      const n = await networkSummary(db, NETWORK, CHAIN_ID);
      const pairs = await Promise.all(
        PAIRS.map(async ({ symbol, decimals }) => {
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
// USYC lives on Arc mainnet only: its price, growth and supply, free here and paid at /v1/paid/arc/usyc.
const usyc = NETWORK === "mainnet" ? usycReader((process.env.ARC_RPC_URLS ?? "https://rpc.mainnet.arc.io").split(",").map((u) => u.trim()).filter(Boolean)) : null;
app.get("/v1/usyc", async (c) => {
  if (!usyc) return c.json({ error: "USYC is read on Arc mainnet only" }, 404);
  try {
    return c.json(await usyc.read());
  } catch (err) {
    return c.json({ error: `could not read USYC on Arc right now: ${(err as Error).message.slice(0, 120)}` }, 502);
  }
});
const paid = mountPaidRoutes(app, db, NETWORK, log, usyc);
const market = mountMarket(app, db, NETWORK, log, paid ? { ourNetworks: paid.networks, ourPlainNetworks: paid.plainNetworks } : {});
mountBazaar(app, { catalogue: market.catalogue, network: NETWORK, log });
mountThink(app, db, cached);
// Who is behind the addresses in the direct payments: mainnet only, since the sources describe mainnet.
if (NETWORK === "mainnet" && process.env.LABELS !== "off") {
  startLabeler({
    db,
    log,
    circle: market.circle,
    ours: async () => ({ seller: process.env.SELLER_ADDRESS ?? null, facilitator: (await facilitatorHealth())?.signer ?? null }),
    rpcUrls: (process.env.ARC_RPC_URLS ?? "").split(",").map((u) => u.trim()).filter(Boolean),
  });
}
mountLane(app, db, log);
mountFacilitator(app, db, NETWORK, log);

app.onError((err, c) => {
  log.error({ err, path: c.req.path }, "request failed");
  return c.json({ error: "internal error" }, 500);
});

if (existsSync(WEB_DIR)) {
  const rel = WEB_DIR.startsWith(process.cwd()) ? WEB_DIR.slice(process.cwd().length + 1) : WEB_DIR;
  app.use("/*", serveStatic({ root: rel, rewriteRequestPath: (p) => (p === "/dashboard" || p === "/network" ? "/dashboard.html" : p === "/token" ? "/token.html" : p === "/try" ? "/try.html" : p === "/status" ? "/status.html" : p === "/factory" ? "/factory.html" : p === "/market" ? "/market.html" : p === "/bazaar" ? "/bazaar.html" : p === "/think" ? "/think.html" : p === "/usyc" ? "/usyc.html" : p === "/lane" ? "/lane.html" : p === "/register" ? "/register.html" : p) }));
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
