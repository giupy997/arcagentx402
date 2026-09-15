/**
 * Express flavour of the seller: same route table, same Circle Gateway settlement.
 *
 *   const seller = createExpressSeller({ sellerAddress, network: "arc" }).route("GET /v1/forecast", "$0.001");
 *   app.use(seller.middleware());
 */
import { BatchFacilitatorClient, GatewayEvmScheme } from "@circle-fin/x402-batching/server";
import type { FacilitatorClient, RouteConfig } from "@x402/core/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { buildRoutes, resolveNetwork, type RouteOptions, type SellerConfig } from "./index.js";

type ExpressMiddleware = ReturnType<typeof paymentMiddleware>;

export interface ExpressSeller {
  route(pattern: string, price: string, opts?: RouteOptions): ExpressSeller;
  middleware(): ExpressMiddleware;
  readonly routes: Record<string, RouteConfig>;
}

export function createExpressSeller(cfg: SellerConfig): ExpressSeller {
  const { network, facilitatorUrl } = resolveNetwork(cfg);
  const routes: Record<string, RouteConfig> = {};
  let mw: ExpressMiddleware | null = null;
  const seller: ExpressSeller = {
    routes,
    route(pattern, price, opts = {}) {
      if (mw) throw new Error("seller.route() must be called before seller.middleware()");
      routes[pattern] = buildRoutes(cfg, network, pattern, price, opts);
      return seller;
    },
    middleware() {
      if (!mw) {
        const facilitator = new BatchFacilitatorClient({ url: facilitatorUrl }) as unknown as FacilitatorClient;
        const server = new x402ResourceServer(facilitator).register(network, new GatewayEvmScheme());
        mw = paymentMiddleware(routes, server);
      }
      return mw;
    },
  };
  return seller;
}
