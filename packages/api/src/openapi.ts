/**
 * The OpenAPI document served at /openapi.json.
 *
 * This is how agents and the x402 directories find out what is here, what it costs and how to pay:
 * each priced operation carries `x-payment-info` with the price and the x402 payment option, which
 * is the same requirement the 402 response advertises. It is built from the route catalogue, so a
 * route that is sold is always described.
 */
import { atLeast } from "@cra-agent/seller";
import { FREE_ROUTES, PAID_ROUTES, type QueryParam } from "./routes.js";

/** A network besides Arc where a priced route takes a plain x402 payment: Base or Solana. */
export interface PlainRail {
  /** CAIP-2, e.g. eip155:8453. */
  readonly network: string;
  /** How the text names it: Base, Solana. */
  readonly name: string;
  readonly asset: string;
  readonly payTo: string;
  /** The smallest payment the facilitator there takes, "$0.001": a cheaper route costs that much on this network. */
  readonly minPrice?: string;
}

export interface OpenApiOptions {
  readonly origin: string;
  /** CAIP-2 network the payment settles on, e.g. eip155:5042. */
  readonly network: string;
  readonly sellerAddress: string | null;
  readonly usdcAddress: string;
  readonly version: string;
  /** The thinking agent billed by use (x402 upto), when it runs on this host: its ceiling and fee in USDC. */
  readonly upto?: { readonly ceilingUsdc: string; readonly feeUsdc: string } | null;
  /** The networks besides Arc that the priced routes and the thinking agent are also paid on. */
  readonly plain?: readonly PlainRail[];
  /** The same routes under /v1/direct, settled one by one on Arc, when that rail is on: the least a call costs there. */
  readonly direct?: { readonly floorUsdc: string } | null;
}

/** "Arc", "Arc or Base", "Arc, Base or Solana". */
const either = (names: readonly string[]): string => (names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`);

/** What a route costs on each network it is paid on, the way its 402 asks: "$0.0005 in USDC on Arc, $0.001 on Base or Solana". */
function pricesOn(price: string, plain: readonly PlainRail[]): string {
  const byPrice = new Map<string, string[]>([[price, ["Arc"]]]);
  for (const p of plain) {
    const there = atLeast(price, p.minPrice);
    byPrice.set(there, [...(byPrice.get(there) ?? []), p.name]);
  }
  return [...byPrice].map(([at, names], i) => `${at}${i === 0 ? " in USDC" : ""} on ${either(names)}`).join(", ");
}

/** What an agent should know before it buys, saying only what this host has on. */
function guidance(opts: OpenApiOptions): string {
  const plain = opts.plain ?? [];
  const names = plain.map((p) => p.name);
  const min = plain.find((p) => p.minPrice)?.minPrice;
  const networks = plain.length
    ? `The 402 lists every network the route takes, so pick the one your wallet is on: Arc through Circle Gateway (deposit once, then each call is a signature, with no gas), or ${either(names)} with a plain x402 payment${min ? `, where a call costs at least ${min}` : ""}.`
    : "On Arc it is paid through Circle Gateway: deposit once, then each call is a signature, with no gas.";
  const direct = opts.direct
    ? ` The same routes are served under /v1/direct for a direct EIP-3009 payment on Arc from any wallet, with no deposit, at $${opts.direct.floorUsdc} or more a call, since each one is settled on its own.`
    : "";
  return [
    "CRA AGENT sells data by the call over x402, paid in USDC: Arc chain data, executed prices from real swaps on Arc, and public sources (web pages, Wikipedia, npm, PyPI, security advisories, DNS, WHOIS, ECB rates) as clean JSON.",
    `Free routes under /v1 need no payment and no signup. Priced routes under /v1/paid answer 402 with the payment requirements in the payment-required header; pay with any x402 client and repeat the request. ${networks}${direct}`,
    "Two things worth knowing before you buy. The payment is settled only after the handler succeeds, so a failing endpoint costs you nothing: GET /v1/paid/selftest/fail always answers 500 and is never charged, and it is there so you can check that yourself. And every settled payment is listed at cra-agent.tech/status.",
    ...(opts.upto
      ? [`GET /v1/upto/think?task=... hires our thinking agent over x402 upto${plain.length ? `, on ${either(["Arc", ...names])}` : ""}: you sign once for up to $${opts.upto.ceilingUsdc} and are charged what the run spent plus $${opts.upto.feeUsdc}, nothing when it could not start.`]
      : []),
    "Prices range from $0.0005 to $0.005 per call. The Arc network routes (fees, deploys, rpc, fx) are read from Arc by our own collector. The /arc routes read the chain live. The rest (web, packages, domains, currency, wiki) return public sources as one clean JSON shape, and every answer names its source. A bad parameter answers 400 and an upstream failure 502, and neither is ever charged.",
  ].join("\n\n");
}

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
  const plain = opts.plain ?? [];
  const everywhere = either(["Arc", ...plain.map((p) => p.name)]);
  /** The same payment on Base or Solana: a plain transfer there, at no less than that facilitator's minimum. */
  const plainProtocols = (scheme: "exact" | "upto", price: string) =>
    plain.map((p) => ({ x402: { protocol: "x402", version: 2, scheme, network: p.network, asset: p.asset, amount: baseUnits(atLeast(price, p.minPrice)), payTo: p.payTo, maxTimeoutSeconds: 300 } }));

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
            ...plainProtocols("exact", r.price),
          ],
        },
        responses: {
          ...(r.alwaysFails
            ? { "500": { description: "Always. The payment is verified but never settled." } }
            : { "200": { description: r.summary, content: { "application/json": { schema: { type: "object" } } } } }),
          "402": {
            description: `Payment required: ${pricesOn(r.price, plain)}. Requirements are in the payment-required header.`,
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
            ...plainProtocols("upto", ceilingUsdc),
          ],
        },
        responses: {
          "200": { description: "The answer, what was charged, and every payment the agent made.", content: { "application/json": { schema: { type: "object" } } } },
          "402": { description: `Payment required: up to $${ceilingUsdc} in USDC on ${everywhere}, x402 upto. Requirements are in the payment-required header.`, content: { "application/json": { schema: { type: "object" } } } },
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "CRA AGENT data",
      version: opts.version,
      description: `Data for agents by the call, paid in USDC over x402 on ${everywhere}: Arc chain data, executed prices from real swaps on Arc, and public sources (web pages, Wikipedia, npm, PyPI, security advisories, DNS, WHOIS, ECB rates) as clean JSON. Free summaries under /v1, priced routes under /v1/paid${opts.upto ? ", and a research agent billed by use at /v1/upto/think" : ""}.`,
      "x-guidance": guidance(opts),
      termsOfService: "https://cra-agent.tech/terms",
      contact: { name: "CRA AGENT", url: "https://cra-agent.tech", email: "craagentarc@gmail.com" },
      license: { name: "MIT", url: "https://github.com/giupy997/arcagentx402/blob/main/LICENSE" },
    },
    servers: [{ url: opts.origin }],
    tags: [
      { name: "free", description: "No payment, no signup." },
      { name: "paid", description: `Priced per call, paid over x402 in USDC on ${everywhere}.` },
    ],
    paths,
  };
}
