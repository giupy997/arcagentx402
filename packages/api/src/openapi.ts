/**
 * The OpenAPI document served at /openapi.json.
 *
 * This is how agents and the x402 directories find out what is here, what it costs and how to pay:
 * each priced operation carries `x-payment-info` with the price and the x402 payment option, which
 * is the same requirement the 402 response advertises. It is built from the route catalogue, so a
 * route that is sold is always described.
 */
import { FREE_ROUTES, PAID_ROUTES, type QueryParam } from "./routes.js";

export interface OpenApiOptions {
  readonly origin: string;
  /** CAIP-2 network the payment settles on, e.g. eip155:5042. */
  readonly network: string;
  readonly sellerAddress: string | null;
  readonly usdcAddress: string;
  readonly version: string;
}

const GUIDANCE = `CRA AGENT sells Arc chain data by the call over x402, settled in USDC on Arc through Circle Gateway.

Free routes under /v1 need no payment and no signup. Priced routes under /v1/paid answer 402 with the
payment requirements in the payment-required header; pay with any x402 client and repeat the request.

Two things worth knowing before you buy. The payment is settled only after the handler succeeds, so a
failing endpoint costs you nothing: GET /v1/paid/selftest/fail always answers 500 and is never charged,
and it is there so you can check that yourself. And every settled payment ends in a USDC transfer on
Arc whose hash you can look up.

Prices range from $0.0005 to $0.005 per call. The Arc network routes (fees, deploys, rpc, fx) are read
from Arc by our own collector. The /arc routes read the chain live. The rest (web, packages, domains,
currency, wiki) return public sources as one clean JSON shape, and every answer names its source. A bad
parameter answers 400 and an upstream failure 502, and neither is ever charged.`;

const param = (p: QueryParam) => ({
  name: p.name,
  in: "query",
  required: p.required === true,
  description: p.description,
  schema: { type: p.type, ...(p.example === undefined ? {} : { example: p.example }) },
});

/** USDC has six decimals; x402 quotes the amount in base units. */
const baseUnits = (price: string): string => {
  const dollars = Number(price.replace("$", ""));
  return String(Math.round(dollars * 1_000_000));
};

export function buildOpenApi(opts: OpenApiOptions): Record<string, unknown> {
  const paths: Record<string, unknown> = {};

  for (const r of FREE_ROUTES) {
    paths[r.path] = {
      get: {
        summary: r.summary,
        description: r.description,
        operationId: r.path.slice(1).replace(/\//g, "_"),
        tags: ["free"],
        ...(r.params ? { parameters: r.params.map(param) } : {}),
        responses: { "200": { description: r.summary, content: { "application/json": { schema: { type: "object" } } } } },
      },
    };
  }

  for (const r of PAID_ROUTES) {
    if (!opts.sellerAddress) continue;
    paths[r.path] = {
      get: {
        summary: r.summary,
        description: r.description,
        operationId: r.path.slice(1).replace(/\//g, "_"),
        tags: ["paid"],
        ...(r.params ? { parameters: r.params.map(param) } : {}),
        "x-payment-info": {
          price: { mode: "fixed", amount: r.price.replace("$", ""), currency: "USD" },
          protocols: [
            {
              x402: {
                protocol: "x402",
                version: 2,
                scheme: "exact",
                network: opts.network,
                asset: opts.usdcAddress,
                amount: baseUnits(r.price),
                payTo: opts.sellerAddress,
                maxTimeoutSeconds: 604900,
              },
            },
          ],
        },
        responses: {
          ...(r.alwaysFails
            ? { "500": { description: "Always. The payment is verified but never settled." } }
            : { "200": { description: r.summary, content: { "application/json": { schema: { type: "object" } } } } }),
          "402": {
            description: `Payment required: ${r.price} in USDC on Arc. Requirements are in the payment-required header.`,
            content: { "application/json": { schema: { type: "object" }, ...(r.preview ? { example: r.preview } : {}) } },
          },
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "CRA AGENT data",
      version: opts.version,
      description:
        "Arc chain data by the call, paid in USDC over x402: base fees, contract deploys, RPC health, and executed prices for a pair against USDC. Free summaries under /v1, priced detail under /v1/paid.",
      "x-guidance": GUIDANCE,
      contact: { name: "CRA AGENT", url: "https://cra-agent.tech" },
      license: { name: "MIT", url: "https://github.com/giupy997/arcagentx402/blob/main/LICENSE" },
    },
    servers: [{ url: opts.origin }],
    tags: [
      { name: "free", description: "No payment, no signup." },
      { name: "paid", description: "Priced per call, paid over x402 in USDC on Arc." },
    ],
    paths,
  };
}
