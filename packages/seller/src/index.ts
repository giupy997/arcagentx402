/**
 * @cra-agent/seller — put a USDC price on a Hono route.
 *
 * Settlement happens AFTER the handler: x402's default flow verifies the payment first, runs the
 * handler, and only then settles. A handler that throws or answers 5xx leaves the buyer uncharged.
 *
 *   const seller = createSeller({ sellerAddress, network: "arcTestnet" });
 *   seller.route("GET /v1/paid/forecast", "$0.001", { description: "..." });
 *   app.use(seller.middleware());
 *
 * Payments are verified and settled by Circle Gateway (batched, gas-free for the buyer); the
 * x402 "exact" scheme is what gets registered, so any x402 buyer can pay, not only CRA AGENT agents.
 */
import { parseUsdc6 } from "@cra-agent/accounting";
import { createFacilitatorConfig } from "@coinbase/x402";
import { BatchFacilitatorClient, GatewayEvmScheme } from "@circle-fin/x402-batching/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient, type FacilitatorClient, type RouteConfig } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions";
import type { Network } from "@x402/core/types";
import type { MiddlewareHandler } from "hono";

export type SellerNetwork = "arc" | "arcTestnet";
const CAIP2: Record<SellerNetwork, Network> = { arc: "eip155:5042", arcTestnet: "eip155:5042002" };
const FACILITATOR: Record<SellerNetwork, string> = { arc: "https://gateway-api.circle.com", arcTestnet: "https://gateway-api-testnet.circle.com" };

/**
 * A second rail, alongside Arc, on a network whose facilitator catalogues what it settles.
 *
 * The x402 discovery catalogue (the Bazaar) is filled by the facilitator that verifies a payment,
 * and no facilitator settles Arc except Circle's, which does not catalogue. Offering the same
 * resource on a catalogued network gets it listed, Arc price and all, without taking anything away
 * from the Arc rail: the buyer picks.
 */
export interface DiscoveryRail {
  /** Address paid on that network. */
  readonly payTo: string;
  /** Facilitator that settles and catalogues this rail. Defaults to Coinbase's. */
  readonly facilitatorUrl?: string;
  /** Coinbase credentials, from the environment. Never hard-code them. Some facilitators need none. */
  readonly cdpKeyId?: string;
  readonly cdpKeySecret?: string;
  /** Defaults to Base mainnet. */
  readonly network?: Network;
  readonly iconUrl?: string;
  readonly tags?: readonly string[];
}

/**
 * A rail on Solana, where most x402 buyers are today. The buyer pays USDC on Solana and the seller
 * is paid there, on the address given: nothing crosses chains. Settled by an open facilitator that
 * completes the buyer's transaction and pays its fee (PayAI by default).
 */
export interface SolanaRail {
  /** The seller's Solana address. Its USDC token account is created by the first payment if missing. */
  readonly payTo: string;
  readonly facilitatorUrl?: string;
}

export const SOLANA_MAINNET: Network = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const SOLANA_DEVNET: Network = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const PAYAI_FACILITATOR = "https://facilitator.payai.network";

export interface SellerConfig {
  readonly sellerAddress: string;
  readonly network: SellerNetwork;
  readonly facilitatorUrl?: string;
  readonly serviceName?: string;
  readonly discovery?: DiscoveryRail;
  readonly solana?: SolanaRail;
  /**
   * How Arc payments are settled. "gateway" (default) is Circle Gateway: batched, cheapest at
   * volume, but the buyer has to deposit first. "direct" is a plain EIP-3009 authorization settled
   * by the facilitator at `facilitatorUrl`: the buyer signs from its wallet, nothing to deposit, and
   * the transaction hash comes back in the response. A browser wallet can only do the second.
   * One server settles one way per network, so pick per seller, not per route.
   */
  readonly settlement?: "gateway" | "direct";
  /**
   * Told about every payment that passed verification, however it ended. Called without being
   * awaited and never allowed to throw into the payment: a slow or broken sink cannot hold a response.
   */
  readonly onSettlement?: (event: SettlementEvent) => void | Promise<void>;
}

/**
 * How a verified payment ended. "not_charged" is a payment that was valid and never settled because
 * the handler failed: the authorization was dropped unused.
 */
export interface SettlementEvent {
  readonly outcome: "settled" | "failed" | "not_charged";
  readonly network: string;
  readonly payer: string | null;
  readonly payTo: string;
  /** In the asset's base units, as the requirements spelled it. */
  readonly amount: string;
  /** A transaction hash on a direct rail, the facilitator's transfer id on a batched one. */
  readonly transaction: string | null;
  readonly reason: string | null;
  /** The URL that was bought, as the buyer's payload named it. */
  readonly resource: string | null;
}

/** Arc's USDC, as the ERC-20 the exact scheme moves. The SDK has no default asset for Arc yet. */
export const ARC_USDC_ASSET = { asset: "0x3600000000000000000000000000000000000000", extra: { name: "USDC", version: "2" } } as const;

export interface RouteOptions {
  readonly description?: string;
  readonly mimeType?: string;
  readonly maxTimeoutSeconds?: number;
  /** Body returned to unpaid API callers next to the 402 (preview, docs pointer). */
  readonly preview?: unknown;
  /** JSON Schema of the query this route takes, published to the discovery catalogue. */
  readonly inputSchema?: Record<string, unknown>;
  /** An example of what the route answers, published to the discovery catalogue. */
  readonly outputExample?: unknown;
}

export interface Seller {
  /** pattern: "GET /v1/paid/forecast" (method + path, x402 route syntax). price: "$0.001". */
  route(pattern: string, price: string, opts?: RouteOptions): Seller;
  middleware(): MiddlewareHandler;
  readonly routes: Record<string, RouteConfig>;
  readonly network: Network;
  readonly facilitatorUrl: string;
  readonly sellerAddress: string;
}

/** Shared by the Hono and Express flavours. */
export function resolveNetwork(cfg: SellerConfig): { network: Network; facilitatorUrl: string } {
  if (!/^0x[0-9a-fA-F]{40}$/.test(cfg.sellerAddress)) throw new Error("sellerAddress must be a 0x address");
  if (cfg.solana && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(cfg.solana.payTo)) throw new Error("solana.payTo must be a Solana address");
  return { network: CAIP2[cfg.network], facilitatorUrl: cfg.facilitatorUrl ?? FACILITATOR[cfg.network] };
}

export const BASE_MAINNET: Network = "eip155:8453";

export function buildRoutes(cfg: SellerConfig, network: Network, pattern: string, price: string, opts: RouteOptions): RouteConfig {
  const timeout = opts.maxTimeoutSeconds ? { maxTimeoutSeconds: opts.maxTimeoutSeconds } : {};
  // Settled directly, the amount has to be spelled out in base units with the token's signing domain.
  const arcPrice = cfg.settlement === "direct" ? { ...ARC_USDC_ASSET, amount: parseUsdc6(price.replace("$", "")).toString() } : price;
  const arc = { scheme: "exact", network, payTo: cfg.sellerAddress, price: arcPrice, ...timeout };
  const rail = cfg.discovery;
  const method = pattern.split(" ")[0] ?? "GET";
  // Arc first: a buyer that can pay there should. Then the catalogued rail, then Solana.
  const accepts = [
    arc,
    ...(rail ? [{ scheme: "exact", network: rail.network ?? BASE_MAINNET, payTo: rail.payTo, price, ...timeout }] : []),
    ...(cfg.solana ? [{ scheme: "exact", network: cfg.network === "arc" ? SOLANA_MAINNET : SOLANA_DEVNET, payTo: cfg.solana.payTo, price, ...timeout }] : []),
  ];
  return {
    accepts: accepts.length === 1 ? arc : accepts,
    ...(rail
      ? {
          // What the catalogue shows about this route: how to call it and what comes back.
          extensions: declareDiscoveryExtension({
            ...(method === "GET" ? {} : { bodyType: "json" as const }),
            ...(opts.inputSchema ? { inputSchema: opts.inputSchema } : {}),
            ...(opts.outputExample !== undefined ? { output: { example: opts.outputExample } } : {}),
          }),
          ...(rail.tags ? { tags: [...rail.tags] } : {}),
          ...(rail.iconUrl ? { iconUrl: rail.iconUrl } : {}),
        }
      : {}),
    ...(opts.description ? { description: opts.description } : {}),
    mimeType: opts.mimeType ?? "application/json",
    ...(cfg.serviceName ? { serviceName: cfg.serviceName } : {}),
    ...(opts.preview !== undefined ? { unpaidResponseBody: async () => ({ contentType: "application/json", body: opts.preview }) } : {}),
  };
}

/**
 * The resource server: Circle's batching facilitator for Arc, and when a discovery rail is
 * configured, the CDP facilitator for that network plus the extension that catalogues what it
 * settles.
 */
export function buildServer(cfg: SellerConfig, network: Network, facilitatorUrl: string): x402ResourceServer {
  return observed(cfg, assembleServer(cfg, network, facilitatorUrl));
}

/** Reports how each verified payment ended to `cfg.onSettlement`, when there is one. */
export function observed(cfg: Pick<SellerConfig, "onSettlement">, server: x402ResourceServer): x402ResourceServer {
  const sink = cfg.onSettlement;
  if (!sink) return server;
  type Ctx = { paymentPayload: { resource?: { url?: string }; payload: Record<string, unknown> }; requirements: { network: string; payTo: string; amount: string } };
  const tell = (ctx: Ctx, rest: Pick<SettlementEvent, "outcome" | "transaction" | "reason"> & { payer?: string | undefined }): void => {
    const signedBy = (ctx.paymentPayload.payload.authorization as { from?: unknown } | undefined)?.from;
    const event: SettlementEvent = {
      outcome: rest.outcome,
      network: ctx.requirements.network,
      payer: rest.payer ?? (typeof signedBy === "string" ? signedBy : null),
      payTo: ctx.requirements.payTo,
      amount: ctx.requirements.amount,
      transaction: rest.transaction,
      reason: rest.reason,
      resource: ctx.paymentPayload.resource?.url ?? null,
    };
    void Promise.resolve()
      .then(() => sink(event))
      .catch(() => {});
  };
  return server
    .onAfterSettle(async (ctx) => tell(ctx, { outcome: "settled", transaction: ctx.result.transaction || null, reason: null, payer: ctx.result.payer }))
    .onSettleFailure(async (ctx) => tell(ctx, { outcome: "failed", transaction: null, reason: ctx.error.message.slice(0, 200) }))
    .onVerifiedPaymentCanceled(async (ctx) => tell(ctx, { outcome: "not_charged", transaction: null, reason: ctx.reason }));
}

function assembleServer(cfg: SellerConfig, network: Network, facilitatorUrl: string): x402ResourceServer {
  // The SDK declares its own structural PaymentPayload/Requirements; identical at runtime, stricter under exactOptionalPropertyTypes.
  if (cfg.settlement === "direct") {
    if (!cfg.facilitatorUrl) throw new Error('settlement: "direct" needs facilitatorUrl, the facilitator that settles the authorizations');
    return new x402ResourceServer(new HTTPFacilitatorClient({ url: cfg.facilitatorUrl })).register(network, new ExactEvmScheme());
  }
  const circle = new BatchFacilitatorClient({ url: facilitatorUrl }) as unknown as FacilitatorClient;
  const rail = cfg.discovery;
  if (!rail && !cfg.solana) return new x402ResourceServer(circle).register(network, new GatewayEvmScheme());
  if (!rail) {
    // Solana alone: its facilitator does not claim Arc, so the order is free; it goes first for symmetry with below.
    const payai = new HTTPFacilitatorClient({ url: cfg.solana!.facilitatorUrl ?? PAYAI_FACILITATOR });
    return new x402ResourceServer([payai, circle]).register(network, new GatewayEvmScheme()).register(solanaNetwork(cfg), new ExactSvmScheme());
  }
  // Credentials when the facilitator wants them, plain HTTP when it is open to anyone.
  const catalogued = new HTTPFacilitatorClient(
    rail.cdpKeyId && rail.cdpKeySecret
      ? createFacilitatorConfig(rail.cdpKeyId, rail.cdpKeySecret)
      : { url: rail.facilitatorUrl ?? (() => { throw new Error("discovery rail needs either CDP credentials or a facilitatorUrl"); })() },
  );
  // Order matters: the first facilitator that claims a network gets it. Circle claims Base too, so
  // the catalogued one goes first and Arc still lands on Circle, which is the only one that has it.
  const solana = cfg.solana ? new HTTPFacilitatorClient({ url: cfg.solana.facilitatorUrl ?? PAYAI_FACILITATOR }) : null;
  const server = new x402ResourceServer(solana ? [catalogued, solana, circle] : [catalogued, circle])
    .register(network, new GatewayEvmScheme())
    .register(rail.network ?? BASE_MAINNET, new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension);
  return cfg.solana ? server.register(solanaNetwork(cfg), new ExactSvmScheme()) : server;
}

const solanaNetwork = (cfg: SellerConfig): Network => (cfg.network === "arc" ? SOLANA_MAINNET : SOLANA_DEVNET);

export function createSeller(cfg: SellerConfig): Seller {
  const { network, facilitatorUrl } = resolveNetwork(cfg);
  const routes: Record<string, RouteConfig> = {};
  let mw: MiddlewareHandler | null = null;
  const seller: Seller = {
    routes,
    network,
    facilitatorUrl,
    sellerAddress: cfg.sellerAddress,
    route(pattern, price, opts = {}) {
      if (mw) throw new Error("seller.route() must be called before seller.middleware()");
      routes[pattern] = buildRoutes(cfg, network, pattern, price, opts);
      return seller;
    },
    middleware() {
      if (!mw) mw = paymentMiddleware(routes, buildServer(cfg, network, facilitatorUrl));
      return mw;
    },
  };
  return seller;
}
