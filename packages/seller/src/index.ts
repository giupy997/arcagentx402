/**
 * @arc-rail/seller — put a USDC price on a Hono route.
 *
 *   const seller = createSeller({ sellerAddress, network: "arcTestnet" });
 *   seller.route("GET /v1/paid/forecast", "$0.001", { description: "..." });
 *   app.use(seller.middleware());
 *
 * Payments are verified and settled by Circle Gateway (batched, gas-free for the buyer); the
 * x402 "exact" scheme is what gets registered, so any x402 buyer can pay, not only ArcRail agents.
 */
import { BatchFacilitatorClient, GatewayEvmScheme } from "@circle-fin/x402-batching/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import type { FacilitatorClient, RouteConfig } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import type { MiddlewareHandler } from "hono";

export type SellerNetwork = "arc" | "arcTestnet";
const CAIP2: Record<SellerNetwork, Network> = { arc: "eip155:5042", arcTestnet: "eip155:5042002" };
const FACILITATOR: Record<SellerNetwork, string> = { arc: "https://gateway-api.circle.com", arcTestnet: "https://gateway-api-testnet.circle.com" };

export interface SellerConfig {
  readonly sellerAddress: string;
  readonly network: SellerNetwork;
  readonly facilitatorUrl?: string;
  readonly serviceName?: string;
}

export interface RouteOptions {
  readonly description?: string;
  readonly mimeType?: string;
  readonly maxTimeoutSeconds?: number;
  /** Body returned to unpaid API callers next to the 402 (preview, docs pointer). */
  readonly preview?: unknown;
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

export function createSeller(cfg: SellerConfig): Seller {
  if (!/^0x[0-9a-fA-F]{40}$/.test(cfg.sellerAddress)) throw new Error("sellerAddress must be a 0x address");
  const network = CAIP2[cfg.network];
  const facilitatorUrl = cfg.facilitatorUrl ?? FACILITATOR[cfg.network];
  const routes: Record<string, RouteConfig> = {};
  let mw: MiddlewareHandler | null = null;
  const seller: Seller = {
    routes,
    network,
    facilitatorUrl,
    sellerAddress: cfg.sellerAddress,
    route(pattern, price, opts = {}) {
      if (mw) throw new Error("seller.route() must be called before seller.middleware()");
      routes[pattern] = {
        accepts: { scheme: "exact", network, payTo: cfg.sellerAddress, price, ...(opts.maxTimeoutSeconds ? { maxTimeoutSeconds: opts.maxTimeoutSeconds } : {}) },
        ...(opts.description ? { description: opts.description } : {}),
        mimeType: opts.mimeType ?? "application/json",
        ...(cfg.serviceName ? { serviceName: cfg.serviceName } : {}),
        ...(opts.preview !== undefined ? { unpaidResponseBody: async () => ({ contentType: "application/json", body: opts.preview }) } : {}),
      };
      return seller;
    },
    middleware() {
      if (!mw) {
        // The SDK declares its own structural PaymentPayload/Requirements; identical at runtime, stricter under exactOptionalPropertyTypes.
        const facilitator = new BatchFacilitatorClient({ url: facilitatorUrl }) as unknown as FacilitatorClient;
        const server = new x402ResourceServer(facilitator).register(network, new GatewayEvmScheme());
        mw = paymentMiddleware(routes, server);
      }
      return mw;
    },
  };
  return seller;
}
