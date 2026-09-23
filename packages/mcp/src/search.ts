/**
 * Finding something to buy.
 *
 * The market's search answers with URLs and prices, from our routes, the CRA market and Circle's
 * x402 catalogue. This checks each one against the agent's own policy the same way a payment would
 * be checked, with what it has already spent, so the agent does not spend a quote on something it
 * may not buy. It also picks which of a route's two addresses the agent can actually pay: the
 * batched one needs a Circle Gateway deposit, the direct one only USDC in the wallet.
 */
import { compareUsdc6, parseUsdc6, usdc6, type Usdc6 } from "@cra-agent/accounting";
import { evaluatePolicy, type SpendPolicy } from "@cra-agent/policy";

export const MARKET_API = process.env.CRA_MARKET_API ?? "https://api.cra-agent.tech";

export interface FoundParam {
  name: string;
  /** query string, a {placeholder} in the path, or the JSON body. Absent from older answers: query. */
  in?: "query" | "path" | "body";
  type: string;
  description: string;
  required: boolean;
  example: unknown;
}
export interface Found {
  url: string;
  method: "GET" | "POST";
  priceUsd: string;
  name: string;
  label: string | null;
  description: string | null;
  params: FoundParam[];
  payTo: string;
  host: string;
  network: string;
  rail: "gateway" | "direct";
  direct: { url: string; priceUsd: string } | null;
  /** For a POST, a JSON body from the seller's own examples, when it gave any. */
  body?: Record<string, unknown> | null;
  /** cra-agent, market or circle. */
  source: string;
  online: boolean;
  score: number;
}
export interface SearchAnswer {
  query: string;
  network: string;
  count: number;
  results: Found[];
  note: string;
}

export async function searchMarket(query: string, opts: { maxUsdc?: string; limit?: number; api?: string; fetchImpl?: typeof fetch } = {}): Promise<SearchAnswer> {
  const u = new URL("/v1/market/search", opts.api ?? MARKET_API);
  u.searchParams.set("q", query);
  if (opts.maxUsdc !== undefined) u.searchParams.set("maxPriceUsd", opts.maxUsdc);
  if (opts.limit !== undefined) u.searchParams.set("limit", String(opts.limit));
  const res = await (opts.fetchImpl ?? fetch)(u, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`market search answered ${res.status}`);
  return (await res.json()) as SearchAnswer;
}

/** What the agent has spent, as the policy counts it. */
export interface Spending {
  readonly day: Usdc6;
  readonly withSeller: (payTo: string) => Usdc6;
  readonly inRateWindow: number;
}
export const NOTHING_SPENT: Spending = { day: usdc6(0n), withSeller: () => usdc6(0n), inRateWindow: 0 };

export interface Fit {
  /** The address to call: batched when there is a Gateway balance for it, direct otherwise. */
  readonly url: string;
  readonly priceUsd: string;
  readonly payable: boolean;
  readonly rule?: string;
  readonly reason?: string;
}

/**
 * Whether this agent can pay for a result now, and at which address. `gatewayAvailable` is the
 * Gateway balance in USDC, or null when it was not read (then the batched address is assumed).
 */
export function fit(found: Found, policy: SpendPolicy, agentNetwork: string, spent: Spending, gatewayAvailable: string | null): Fit {
  let url = found.url;
  let priceUsd = found.priceUsd;
  let amount: Usdc6;
  try {
    amount = parseUsdc6(priceUsd);
  } catch {
    return { url, priceUsd, payable: false, rule: "price", reason: `the price ${priceUsd} is not an amount this agent can pay` };
  }
  // A batched route cannot be paid from an empty Gateway balance; the same route settled directly can.
  const short = gatewayAvailable !== null && found.rail === "gateway" && compareUsdc6(parseUsdc6(gatewayAvailable), amount) < 0;
  if (short && found.direct) {
    ({ url, priceUsd } = found.direct);
    try {
      amount = parseUsdc6(priceUsd);
    } catch {
      return { url, priceUsd, payable: false, rule: "price", reason: `the price ${priceUsd} is not an amount this agent can pay` };
    }
  }
  if (found.network !== agentNetwork) return { url, priceUsd, payable: false, rule: "network", reason: `sold on ${found.network}; this agent pays on ${agentNetwork}` };
  // Sold only through Gateway, and the deposit does not cover it: say so now rather than after a quote.
  if (short && !found.direct) return { url, priceUsd, payable: false, rule: "gateway", reason: `sold only through Circle Gateway, and this agent's Gateway balance is ${gatewayAvailable} USDC: deposit first with arc_deposit` };
  const d = evaluatePolicy(policy, {
    amount,
    network: found.network,
    payTo: found.payTo,
    host: found.host,
    spentInWindow: spent.day,
    spentInWindowWithCounterparty: spent.withSeller(found.payTo),
    paymentsInRateWindow: spent.inRateWindow,
    // Checked when the agent quotes the URL; here it would cost a chain read per result.
    identityVerified: null,
    sellerBond: null,
  });
  return d.allow ? { url, priceUsd, payable: true } : { url, priceUsd, payable: false, rule: d.rule, reason: d.reason };
}

const LISTED_BY: Record<string, string> = { "cra-agent": "CRA AGENT", market: "CRA market", circle: "Circle's x402 catalogue" };

/** A result as an agent should read it: what it is, how to call it, what it costs, whether it may. */
export function forAgent(found: Found, f: Fit | null) {
  const what = found.label ?? found.description ?? found.name;
  return {
    what: what.length > 200 ? `${what.slice(0, 197)}...` : what,
    method: found.method,
    url: f?.url ?? found.url,
    priceUsd: f?.priceUsd ?? found.priceUsd,
    seller: found.name,
    listedBy: LISTED_BY[found.source] ?? found.source,
    params: found.params.map((p) => ({ name: p.name, in: p.in ?? "query", required: p.required, example: p.example, description: p.description })),
    ...(found.body ? { body: found.body } : {}),
    ...(f ? { payable: f.payable, ...(f.payable ? {} : { whyNot: `${f.rule}: ${f.reason}` }) } : {}),
  };
}
