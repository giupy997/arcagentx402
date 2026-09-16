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
import { createFacilitatorConfig } from "@coinbase/x402";
import { BatchFacilitatorClient, GatewayEvmScheme } from "@circle-fin/x402-batching/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient, type FacilitatorClient, type RouteConfig } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
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

export interface SellerConfig {
  readonly sellerAddress: string;
  readonly network: SellerNetwork;
  readonly facilitatorUrl?: string;
  readonly serviceName?: string;
  readonly discovery?: DiscoveryRail;
}

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
  return { network: CAIP2[cfg.network], facilitatorUrl: cfg.facilitatorUrl ?? FACILITATOR[cfg.network] };
}

export const BASE_MAINNET: Network = "eip155:8453";

export function buildRoutes(cfg: SellerConfig, network: Network, pattern: string, price: string, opts: RouteOptions): RouteConfig {
  const timeout = opts.maxTimeoutSeconds ? { maxTimeoutSeconds: opts.maxTimeoutSeconds } : {};
  const arc = { scheme: "exact", network, payTo: cfg.sellerAddress, price, ...timeout };
  const rail = cfg.discovery;
  const method = pattern.split(" ")[0] ?? "GET";
  return {
    accepts: rail ? [arc, { scheme: "exact", network: rail.network ?? BASE_MAINNET, payTo: rail.payTo, price, ...timeout }] : arc,
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
  // The SDK declares its own structural PaymentPayload/Requirements; identical at runtime, stricter under exactOptionalPropertyTypes.
  const circle = new BatchFacilitatorClient({ url: facilitatorUrl }) as unknown as FacilitatorClient;
  const rail = cfg.discovery;
  if (!rail) return new x402ResourceServer(circle).register(network, new GatewayEvmScheme());
  // Credentials when the facilitator wants them, plain HTTP when it is open to anyone.
  const catalogued = new HTTPFacilitatorClient(
    rail.cdpKeyId && rail.cdpKeySecret
      ? createFacilitatorConfig(rail.cdpKeyId, rail.cdpKeySecret)
      : { url: rail.facilitatorUrl ?? (() => { throw new Error("discovery rail needs either CDP credentials or a facilitatorUrl"); })() },
  );
  // Order matters: the first facilitator that claims a network gets it. Circle claims Base too, so
  // the catalogued one goes first and Arc still lands on Circle, which is the only one that has it.
  return new x402ResourceServer([catalogued, circle])
    .register(network, new GatewayEvmScheme())
    .register(rail.network ?? BASE_MAINNET, new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension);
}

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
