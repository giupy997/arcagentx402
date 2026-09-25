import type { Hono } from "hono";
import { compareUsdc6, formatUsdc6, parseUsdc6 } from "@cra-agent/accounting";
import type { Logger } from "pino";
import { createSeller, type SettlementEvent } from "@cra-agent/seller";
import type { Db } from "./db.js";
import { deployStats, feeEstimate, feeSummary, fxSummary, marketPrices, recentDeploys, recordSettlement, rpcStatus } from "./queries.js";
import { PAIRS, resolvePair } from "./pairs.js";
import { PAID_ROUTES, type QueryParam } from "./routes.js";
import { mountToolHandlers } from "./tools.js";
import { btcUsdRate, LNBTC_MAINNET, LNBTC_TESTNET, nwcReceiver, PgReplayStore, readConnection, type ReceiverAdapter } from "@cra-agent/lightning";
import { lightningMiddleware } from "./lightning.js";

/** What a route costs on the direct rail: its own price, but never below the floor that covers our gas. */
export function directPriceOf(price: string): string {
  const floor = parseUsdc6(process.env.DIRECT_MIN_PRICE_USDC ?? "0.003");
  const asked = parseUsdc6(price.replace("$", ""));
  return formatUsdc6(compareUsdc6(asked, floor) < 0 ? floor : asked);
}

/** The query a route takes, as JSON Schema, for the discovery catalogue. */
function querySchema(params: readonly QueryParam[]): Record<string, unknown> {
  return {
    type: "object",
    properties: Object.fromEntries(params.map((p) => [p.name, { type: p.type, description: p.description, ...(p.example === undefined ? {} : { example: p.example })}])),
    required: params.filter((p) => p.required).map((p) => p.name),
  };
}

/**
 * The first paid endpoints on the rail: our own Arc data, priced per call, paid via x402 + Circle Gateway.
 * Enabled only when SELLER_ADDRESS is set; the free /v1 routes stay free.
 */
export function mountPaidRoutes(app: Hono, db: Db, network: string, log: Logger): { networks: string[]; plainNetworks: string[] } | null {
  const sellerAddress = process.env.SELLER_ADDRESS;
  if (!sellerAddress) {
    log.warn("SELLER_ADDRESS not set: paid endpoints disabled");
    return null;
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

  // Every verified payment is written down with how it ended: that table is the public /status page.
  const arcNetwork = network === "mainnet" ? "eip155:5042" : "eip155:5042002";
  const record = (arcRail: "gateway" | "direct") => (e: SettlementEvent): Promise<void> => {
    let route: string | null = null;
    try {
      route = e.resource ? new URL(e.resource).pathname : null;
    } catch {
      route = null;
    }
    const row = { rail: e.network === arcNetwork ? arcRail : e.network.startsWith("solana:") ? ("solana" as const) : ("base" as const), network: e.network, outcome: e.outcome, payer: e.payer, payTo: e.payTo, amountUsdc6: e.amount, tx: e.transaction, reason: e.reason, route };
    return recordSettlement(db, row).catch((err: unknown) => log.warn({ err, tx: e.transaction }, "settlement not recorded"));
  };

  // Priced from the shared catalogue, so the OpenAPI document and the 402 always agree.
  // The same routes for sale to buyers on Solana, paid there. On by giving a Solana address.
  const solanaPayTo = process.env.SOLANA_SELLER_ADDRESS;
  const seller = createSeller({
    sellerAddress,
    network: network === "mainnet" ? "arc" : "arcTestnet",
    serviceName: "CRA AGENT data",
    onSettlement: record("gateway"),
    ...(solanaPayTo ? { solana: { payTo: solanaPayTo } } : {}),
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
  handlersUnder("/v1/paid");

  // The same routes settled directly: the buyer signs from its wallet, nothing to deposit, and the
  // transaction hash comes back with the data. This is the rail a browser wallet can use. It needs
  // a facilitator that settles plain authorizations on Arc, which is ours, listening on localhost.
  const directFacilitator = process.env.DIRECT_FACILITATOR_URL;
  if (directFacilitator) {
    const direct = createSeller({ sellerAddress, network: network === "mainnet" ? "arc" : "arcTestnet", serviceName: "CRA AGENT data", settlement: "direct", facilitatorUrl: directFacilitator, onSettlement: record("direct") });
    // Settled one by one, every payment costs us about $0.002 of gas, more than our cheapest route
    // charges. Below that price a stranger could drain the gas wallet at a profit to nobody, so the
    // direct rail has a floor. Batched settlement on /v1/paid is what makes the lower prices possible.
    const directPrice = (price: string): string => `$${directPriceOf(price)}`;
    for (const r of PAID_ROUTES) {
      direct.route(`GET ${r.path.replace("/v1/paid", "/v1/direct")}`, directPrice(r.price), { description: r.description, maxTimeoutSeconds: 120, ...(r.preview === undefined ? {} : { preview: r.preview }) });
    }
    app.use("/v1/direct/*", direct.middleware());
    handlersUnder("/v1/direct");
    log.info({ facilitator: directFacilitator, routes: PAID_ROUTES.length }, "direct settlement routes mounted");
  }

  // The same routes paid in bitcoin over Lightning, when our node's receive-only connection is on this host.
  // The route that fails on purpose is left out: a Lightning payment cannot be handed back.
  const lightningFile = process.env.LIGHTNING_NWC_FILE;
  const lightningNetwork = network === "mainnet" ? LNBTC_MAINNET : LNBTC_TESTNET;
  const lightningRoutes = PAID_ROUTES.filter((r) => !r.alwaysFails).map((r) => ({ path: r.path.replace("/v1/paid", "/v1/lightning"), priceUsd: r.price.replace("$", ""), description: r.description }));
  let node: Promise<ReceiverAdapter> | null = null;
  // Asked for when first needed and again after a failure, so a node that is down at start comes back on its own.
  const receiver = (): Promise<ReceiverAdapter> => {
    node ??= nwcReceiver(readConnection(lightningFile!)).catch((err: unknown) => {
      node = null;
      log.warn({ err: (err as Error).message }, "lightning node not reachable");
      throw err;
    });
    return node;
  };
  const rate = btcUsdRate();
  if (lightningFile) {
    app.use(
      "/v1/lightning/*",
      lightningMiddleware({
        receiver,
        network: lightningNetwork,
        publicOrigin: process.env.PUBLIC_API_ORIGIN ?? "https://api.cra-agent.tech",
        routes: lightningRoutes,
        replay: new PgReplayStore(db),
        rate,
        minMsat: BigInt(process.env.LIGHTNING_MIN_MSAT ?? "1000"),
        onSettled: async (e) => {
          const payTo = (await receiver()).pubkey;
          await recordSettlement(db, { rail: "lightning", network: lightningNetwork, outcome: "settled", payer: null, payTo, amountUsdc6: parseUsdc6(e.priceUsd).toString(), tx: e.paymentHash, reason: e.status >= 400 ? `paid, then the route answered ${e.status}` : null, route: e.route }).catch((err: unknown) => log.warn({ err, tx: e.paymentHash }, "lightning settlement not recorded"));
        },
      }),
    );
    handlersUnder("/v1/lightning");
    log.info({ routes: lightningRoutes.length, network: lightningNetwork }, "lightning routes mounted");
  }
  app.get("/v1/lightning", async (c) => {
    if (!lightningFile) return c.json({ lightning: "off" });
    const pubkey = await receiver().then((r) => r.pubkey).catch(() => null);
    const btcUsd = await rate().then((r) => r.rate).catch(() => null);
    return c.json({
      scheme: "exact",
      network: lightningNetwork,
      asset: "BTC",
      payTo: pubkey,
      spec: "https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_lnbtc.md",
      pricing: "each route's dollar price in millisatoshis at the median BTC/USD of Coinbase, Kraken and Bitstamp, rounded up, at least 1 sat; an invoice lasts 300 seconds",
      btcUsd,
      routes: lightningRoutes.map((r) => ({ route: `GET ${r.path}`, priceUsd: r.priceUsd })),
    });
  });

  function handlersUnder(prefix: string): void {


  app.get(`${prefix}/fees/forecast`, async (c) => {
    const f = await feeSummary(db, 360);
    const last = f.series.slice(-30);
    const trend = last.length >= 2 ? Number((last[last.length - 1]!.utilization - last[0]!.utilization).toFixed(4)) : 0;
    return c.json({ ...f, series: last, utilizationTrend30m: trend, floorGwei: f.floorGwei, note: "base fee follows an EWMA of utilisation; next-block fee is exact (from the header), beyond that the trend is the signal" });
  });
  app.get(`${prefix}/fees/estimate`, async (c) => {
    const gasRaw = c.req.query("gas") ?? "21000";
    if (!/^\d{1,9}$/.test(gasRaw)) return c.json({ error: "gas must be an integer" }, 400);
    return c.json(await feeEstimate(db, BigInt(gasRaw)));
  });
  app.get(`${prefix}/deploys/history`, async (c) => {
    const limit = Math.min(1000, Math.max(1, Number(c.req.query("limit") ?? 200)));
    return c.json({ recent: await recentDeploys(db, limit, network), perHour: await deployStats(db) });
  });
  app.get(`${prefix}/rpc/health`, async (c) => c.json(await rpcStatus(db)));
  app.get(`${prefix}/market/prices`, async (c) => c.json(await marketPrices(db, PAIRS)));
  // Executed prices for any pair the collector watches against USDC: ?symbol=EURC (default) or the project token.
  app.get(`${prefix}/fx/execution`, async (c) => {
    const w = Math.min(1440, Math.max(5, Number(c.req.query("window") ?? 60)));
    const pair = resolvePair(c.req.query("symbol"));
    if (!pair) return c.json({ error: `we do not price that pair. Priced against USDC: ${PAIRS.map((p) => p.symbol).join(", ")}`, charged: false }, 400);
    return c.json(await fxSummary(db, w, pair.symbol, pair.decimals));
  });
  // The routes that answer from the chain read live and from public sources.
  mountToolHandlers(app, prefix, {
    network,
    rpcUrls: (process.env.ARC_RPC_URLS ?? "").split(",").map((u) => u.trim()).filter(Boolean),
    token: process.env.TOKEN_ADDRESS ? { address: process.env.TOKEN_ADDRESS, symbol: process.env.TOKEN_SYMBOL ?? "CRA" } : null,
  });
  // Deliberately broken, and public: anyone can check that a failed handler is not charged.
  app.get(`${prefix}/selftest/fail`, (c) => c.json({ error: "this endpoint always fails on purpose", charged: false }, 500));

  }

  // Every network a /v1/paid route takes: Arc, and Base and Solana when those rails are on.
  const networks = [seller.network, ...(discovery ? ["eip155:8453"] : []), ...(solanaPayTo ? ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"] : [])];
  app.get("/v1/direct", (c) => c.json(directFacilitator ? { settlement: "direct", network: seller.network, payTo: seller.sellerAddress, asset: "0x3600000000000000000000000000000000000000", note: "Sign an EIP-3009 authorization from your wallet. No deposit, no gas on your side.", routes: PAID_ROUTES.map((r) => ({ route: `GET ${r.path.replace("/v1/paid", "/v1/direct")}`, summary: r.summary, group: r.group, label: r.plain.label, explain: r.plain.explain, priceUsd: directPriceOf(r.price), params: r.params ?? [], alwaysFails: r.alwaysFails === true })) } : { settlement: "off" }));
  // The same self-description the sell command serves, so a directory reads us the way it reads anyone.
  app.get("/.well-known/x402", (c) =>
    c.json({
      x402Version: 2,
      name: "CRA AGENT data",
      description: "Arc network data, executed prices for cirBTC, WETH, EURC and CRA, and public sources as clean JSON. Settled only when the call succeeds.",
      network: seller.network,
      payTo: seller.sellerAddress,
      ...(solanaPayTo ? { solana: { payTo: solanaPayTo } } : {}),
      networks,
      settlement: directFacilitator ? "circle-gateway on /v1/paid, direct on /v1/direct" : "circle-gateway",
      routes: PAID_ROUTES.map((r) => ({ pattern: `GET ${r.path}`, priceUsd: r.price.replace("$", ""), description: r.summary })),
      // Registered from the payout address itself, on 2026-09-23 (tx 0xecbd1594…7eff): owner and agentWallet are payTo.
      erc8004: { agentId: 186, agentRegistry: "eip155:5042:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", card: "https://cra-agent.tech/.well-known/agent.json" },
      poweredBy: "https://cra-agent.tech",
    }),
  );
  app.get("/v1/paid", (c) => c.json({ seller: seller.sellerAddress, network: seller.network, facilitator: seller.facilitatorUrl, routes: Object.entries(seller.routes).map(([k, v]) => ({ route: k, price: String((Array.isArray(v.accepts) ? v.accepts[0] : v.accepts)?.price), description: v.description ?? null })) }));
  log.info({ seller: sellerAddress, network: seller.network, routes: Object.keys(seller.routes).length, solana: solanaPayTo ?? "off", discovery: discovery ? `${basePayTo} via ${discoveryFacilitator ?? "coinbase"}` : "off" }, "paid endpoints mounted");
  // On Arc a /v1/paid route is paid through Circle Gateway; on Base and Solana with a plain transfer.
  return { networks, plainNetworks: networks.filter((n) => n !== seller.network) };
}
