/**
 * Express flavour of the seller: same route table, same settlement, same discovery rail.
 *
 *   const seller = createExpressSeller({ sellerAddress, network: "arc" }).route("GET /v1/forecast", "$0.001");
 *   app.use(seller.middleware());
 */
import type { RouteConfig } from "@x402/core/server";
import { paymentMiddleware, type x402ResourceServer } from "@x402/express";
import { buildRoutes, buildServer, resolveNetwork, type RouteOptions, type SellerConfig } from "./index.js";

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
      // Same server as the Hono flavour: Arc through Circle, and the discovery rail when configured.
      if (!mw) mw = paymentMiddleware(routes, buildServer(cfg, network, facilitatorUrl) as unknown as x402ResourceServer);
      return mw;
    },
  };
  return seller;
}
