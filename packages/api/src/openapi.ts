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
  /** The thinking agent billed by use (x402 upto), when it runs on this host: its ceiling and fee in USDC. */
  readonly upto?: { readonly ceilingUsdc: string; readonly feeUsdc: string } | null;
}

const GUIDANCE = `CRA AGENT sells Arc chain data by the call over x402, settled in USDC on Arc through Circle Gateway.

Free routes under /v1 need no payment and no signup. Every paid route can also be paid on Solana (USDC, settled by PayAI): the 402 lists both networks, pick the one your wallet is on. Priced routes under /v1/paid answer 402 with the
payment requirements in the payment-required header; pay with any x402 client and repeat the request.

Two things worth knowing before you buy. The payment is settled only after the handler succeeds, so a
failing endpoint costs you nothing: GET /v1/paid/selftest/fail always answers 500 and is never charged,
and it is there so you can check that yourself. And every settled payment ends in a USDC transfer on
Arc whose hash you can look up.

GET /v1/upto/think?task=... hires our thinking agent over x402 upto: you sign once for up to $0.10 and are charged
what the run spent plus $0.005, nothing when it could not start.

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

  // The route that fails on purpose stays out: catalogues read this file, and an agent sent there by one would get
  // an error. It is still served, and /status and /v1/direct say what it is for.
  for (const r of PAID_ROUTES) {
    if (!opts.sellerAddress || r.alwaysFails) continue;
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

  // Billed by use: the buyer signs for the ceiling, and the charge is what the run spent plus the fee.
  if (opts.sellerAddress && opts.upto) {
    const { ceilingUsdc, feeUsdc } = opts.upto;
    paths["/v1/upto/think"] = {
      get: {
        summary: "Hire the thinking agent, billed by what it spends",
        description: `Ask the agent of cra-agent.tech/think anything. It buys its thoughts from an LLM paid per call on Arc and its tools from the bazaar, and answers with every payment it made. Paid with x402 upto: you sign once for up to $${ceilingUsdc} and are charged what the run spent plus $${feeUsdc}, nothing when the run could not start. No approval transaction and no gas on your side.`,
        operationId: "v1_upto_think",
        tags: ["paid"],
        parameters: [param({ name: "task", type: "string", required: true, description: "What you want answered, 3 to 500 characters.", example: "What moved EURC against USDC on Arc today?" })],
        "x-payment-info": {
          price: { mode: "dynamic", currency: "USD", min: feeUsdc, max: ceilingUsdc },
          protocols: [
            {
              x402: {
                protocol: "x402",
                version: 2,
                scheme: "upto",
                network: opts.network,
                asset: opts.usdcAddress,
                amount: baseUnits(ceilingUsdc),
                payTo: opts.sellerAddress,
                maxTimeoutSeconds: 300,
              },
            },
          ],
        },
        responses: {
          "200": { description: "The answer, what was charged, and every payment the agent made.", content: { "application/json": { schema: { type: "object" } } } },
          "402": { description: `Payment required: up to $${ceilingUsdc} in USDC on Arc, x402 upto. Requirements are in the payment-required header.`, content: { "application/json": { schema: { type: "object" } } } },
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
      contact: { name: "CRA AGENT", url: "https://cra-agent.tech", email: "craagentarc@gmail.com" },
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
