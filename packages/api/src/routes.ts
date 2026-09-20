/**
 * The catalogue of what this API sells, in one place: the seller middleware prices these routes and
 * the OpenAPI document describes them, so a route cannot be sold without being described.
 */
export interface QueryParam {
  readonly name: string;
  readonly type: "integer" | "string";
  readonly description: string;
  readonly example?: string | number;
}

export interface PaidRoute {
  /** Path under the origin, as served. */
  readonly path: string;
  /** Price per call, x402 syntax. */
  readonly price: string;
  readonly summary: string;
  readonly description: string;
  readonly params?: readonly QueryParam[];
  /** Body served next to the 402 for a caller who has not paid. */
  readonly preview?: unknown;
  /** This route answers 500 on purpose. */
  readonly alwaysFails?: boolean;
  /** The same thing for someone who is not a developer: a name, and what they get and why they would want it. */
  readonly plain: { readonly label: string; readonly explain: string };
}

const WINDOW: QueryParam = { name: "window", type: "integer", description: "Window in minutes, 5 to 1440.", example: 60 };

export const PAID_ROUTES: readonly PaidRoute[] = [
  {
    path: "/v1/paid/fees/forecast",
    plain: { label: "What a transaction on Arc costs right now", explain: "The network fee on Arc at this moment and for the next block, the range over the last day, and what common actions cost, like sending USDC or swapping. Useful before you send something, to know if now is a cheap or an expensive moment." },
    price: "$0.001",
    summary: "Base fee now and next block",
    description: "Base fee now and next block, 24h band, utilisation trend, cost per operation type",
    preview: { hint: "pay $0.001 USDC via x402 to get the forecast; free summary at /v1/fees" },
  },
  {
    path: "/v1/paid/fees/estimate",
    plain: { label: "The cost of one simple transfer, in dollars", explain: "One number: what a basic transfer costs on Arc right now, in USDC. The smallest and quickest thing you can buy here." },
    price: "$0.0005",
    summary: "Cost of a transaction at the current base fee",
    description: "Cost in USDC of a transaction with the given gas at current and next base fee (?gas=21000)",
    params: [{ name: "gas", type: "integer", description: "Gas the transaction would use.", example: 21000 }],
  },
  {
    path: "/v1/paid/deploys/history",
    plain: { label: "New smart contracts appearing on Arc", explain: "The contracts deployed on Arc most recently, with what we know about each, and how many appear per hour. A way to see what is being built on the chain, as it happens." },
    price: "$0.002",
    summary: "Contract deploys, recent and per hour",
    description: "Recent contract deploys with labels and per-hour history (?limit=200)",
    params: [{ name: "limit", type: "integer", description: "How many deploys to return, 1 to 1000.", example: 200 }],
  },
  {
    path: "/v1/paid/rpc/health",
    plain: { label: "Which Arc connection points are fast and reliable", explain: "Apps talk to Arc through public access points. This shows how fast each one answers and how often it fails, measured by us every few seconds. Useful if you build on Arc and need to pick one." },
    price: "$0.0005",
    summary: "Per-provider RPC latency and head lag",
    description: "Per-provider RPC latency, head lag and error rates, last 15 minutes",
  },
  {
    path: "/v1/paid/fx/execution",
    plain: { label: "The euro to dollar rate on Arc, from real trades", explain: "What people actually paid to swap digital euros (EURC) for digital dollars (USDC) on Arc in the last hour: the average rate, the range, and how the rate changes with the size of the trade. Taken from trades that happened, not from a quoted price." },
    price: "$0.001",
    summary: "Executed prices against USDC, by trade size",
    description:
      "A pair on Arc as executed against USDC: volume-weighted rate, range, the rate by trade size, and where the volume traded. ?symbol=EURC (default) or any token the collector watches.",
    params: [WINDOW, { name: "symbol", type: "string", description: "Base token symbol, quoted in USDC.", example: "EURC" }],
    preview: { hint: "pay $0.001 USDC via x402 for the size curve and venue breakdown; the headline rate is free at /v1/fx" },
  },
  {
    path: "/v1/paid/selftest/fail",
    plain: { label: "A call that fails on purpose (you are not charged)", explain: "This one always breaks. It is here so you can check our claim yourself: you sign the payment, the request fails, and your money never moves. Look at your balance before and after." },
    price: "$0.001",
    summary: "Always fails, on purpose",
    description:
      "Always fails on purpose. Proves the rule: the payment is only settled when the handler succeeds, so a broken endpoint costs the buyer nothing.",
    preview: { hint: "this route always returns 500 after payment is verified; your payment is never settled" },
    alwaysFails: true,
  },
];

export interface FreeRoute {
  readonly path: string;
  readonly summary: string;
  readonly description: string;
  readonly params?: readonly QueryParam[];
}

export const FREE_ROUTES: readonly FreeRoute[] = [
  { path: "/v1/network", summary: "Chain head and collector state", description: "Head block, chain id, genesis, blocks collected and how far behind the collector is." },
  { path: "/v1/fees", summary: "Base fee summary", description: "Base fee now and over the last hours, with the floor and the average cost of a transfer." },
  { path: "/v1/fees/estimate", summary: "Cost of a transaction", description: "Cost in USDC of a transaction with the given gas, at the current base fee.", params: [{ name: "gas", type: "integer", description: "Gas the transaction would use.", example: 21000 }] },
  { path: "/v1/activity", summary: "Blocks, transactions and operations per hour", description: "Per-hour counts of blocks, transactions and operations by type." },
  { path: "/v1/deploys", summary: "Recent contract deploys", description: "The most recent contract deploys seen on chain.", params: [{ name: "limit", type: "integer", description: "How many deploys to return, 1 to 200.", example: 50 }] },
  { path: "/v1/rpc", summary: "Per-provider RPC observations", description: "Latency and head lag of each RPC endpoint the collector polls." },
  { path: "/v1/fx", summary: "Headline executed rate for a pair", description: "Last executed rate and the window summary for a pair against USDC. The size curve and the venues are the paid route.", params: [WINDOW, { name: "symbol", type: "string", description: "Base token symbol, quoted in USDC.", example: "EURC" }] },
  { path: "/v1/token", summary: "Token burns, payouts and price", description: "Buyback burns, USDC payouts and the executed price of the project token, read from the chain." },
  { path: "/v1/selftest", summary: "Hourly self-test of the rail", description: "Our own wallet buying our own endpoint every hour, plus the endpoint that must fail without charging. Not customer activity." },
  { path: "/v1/health", summary: "Service health", description: "503 when the collector is stalled or lagging behind the chain head." },
];
