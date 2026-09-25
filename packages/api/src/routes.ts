/**
 * The catalogue of what this API sells, in one place: the seller middleware prices these routes and
 * the OpenAPI document describes them, so a route cannot be sold without being described.
 */
export interface QueryParam {
  readonly name: string;
  readonly type: "integer" | "string";
  readonly description: string;
  readonly example?: string | number;
  /** The route answers 400 without it. */
  readonly required?: boolean;
}

/** How the catalogue is grouped wherever it is shown to a person. */
export type RouteGroup = "Arc network" | "Arc, read live" | "The web" | "Packages" | "Domains" | "Currencies" | "Wikipedia" | "Proof";

export interface PaidRoute {
  /** Path under the origin, as served. */
  readonly path: string;
  readonly group: RouteGroup;
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

const DATA_ROUTES: readonly PaidRoute[] = [
  {
    path: "/v1/paid/market/prices",
    group: "Arc network",
    plain: { label: "Bitcoin, Ether, euro and CRA prices on Arc, in one call", explain: "The price of every pair we watch, from real swaps on Arc: last trade and how many seconds ago it was, the last hour's average and range, the volume, and the change over 24 hours. Made for an agent that has to decide something and wants one call, not four." },
    price: "$0.002",
    summary: "Every pair at once: last price, freshness, hourly VWAP and range, 24h change",
    description: "All pairs the collector prices against USDC (cirBTC, WETH, EURC, CRA) in one call: last executed price with its age in seconds, hourly volume-weighted price with the 5th-95th percentile range, trade count, volume, and 24h change. From real swaps on Arc, not a quote.",
    preview: { hint: "pay $0.002 USDC via x402 for every pair at once; single pairs are free at /v1/fx?symbol=" },
  },
  {
    path: "/v1/paid/fees/forecast",
    group: "Arc network",
    plain: { label: "What a transaction on Arc costs right now", explain: "The network fee on Arc at this moment and for the next block, the range over the last day, and what common actions cost, like sending USDC or swapping. Useful before you send something, to know if now is a cheap or an expensive moment." },
    price: "$0.001",
    summary: "Base fee now and next block",
    description: "Base fee now and next block, 24h band, utilisation trend, cost per operation type",
    preview: { hint: "pay $0.001 USDC via x402 to get the forecast; free summary at /v1/fees" },
  },
  {
    path: "/v1/paid/fees/estimate",
    group: "Arc network",
    plain: { label: "The cost of one simple transfer, in dollars", explain: "One number: what a basic transfer costs on Arc right now, in USDC. The smallest and quickest thing you can buy here." },
    price: "$0.0005",
    summary: "Cost of a transaction at the current base fee",
    description: "Cost in USDC of a transaction with the given gas at current and next base fee (?gas=21000)",
    params: [{ name: "gas", type: "integer", description: "Gas the transaction would use.", example: 21000 }],
  },
  {
    path: "/v1/paid/deploys/history",
    group: "Arc network",
    plain: { label: "New smart contracts appearing on Arc", explain: "The contracts deployed on Arc most recently, with what we know about each, and how many appear per hour. A way to see what is being built on the chain, as it happens." },
    price: "$0.002",
    summary: "Contract deploys, recent and per hour",
    description: "Recent contract deploys with labels and per-hour history (?limit=200)",
    params: [{ name: "limit", type: "integer", description: "How many deploys to return, 1 to 1000.", example: 200 }],
  },
  {
    path: "/v1/paid/rpc/health",
    group: "Arc network",
    plain: { label: "Which Arc connection points are fast and reliable", explain: "Apps talk to Arc through public access points. This shows how fast each one answers and how often it fails, measured by us every few seconds. Useful if you build on Arc and need to pick one." },
    price: "$0.0005",
    summary: "Per-provider RPC latency and head lag",
    description: "Per-provider RPC latency, head lag and error rates, last 15 minutes",
  },
  {
    path: "/v1/paid/fx/execution",
    group: "Arc network",
    plain: { label: "The price of Bitcoin, Ether or the euro on Arc, from real trades", explain: "What people actually paid on Arc in the last hour to swap Bitcoin (cirBTC), Ether (WETH), digital euros (EURC) or CRA for digital dollars: the average price, the range, and how the price changes with the size of the trade. Taken from trades that happened, not from a quoted price. Write cirBTC, WETH, EURC or CRA in the symbol field." },
    price: "$0.001",
    summary: "Executed prices against USDC, by trade size",
    description:
      "A pair on Arc as executed against USDC: volume-weighted rate, range, the rate by trade size, and where the volume traded. ?symbol=EURC (default), cirBTC, WETH or CRA.",
    params: [WINDOW, { name: "symbol", type: "string", description: "Base token, quoted in USDC: EURC, cirBTC, WETH or CRA.", example: "cirBTC" }],
    preview: { hint: "pay $0.001 USDC via x402 for the size curve and venue breakdown; the headline rate is free at /v1/fx" },
  },
  {
    path: "/v1/paid/selftest/fail",
    group: "Proof",
    plain: { label: "A call that fails on purpose (you are not charged)", explain: "This one always breaks. It is here so you can check our claim yourself: you sign the payment, the request fails, and your money never moves. Look at your balance before and after." },
    price: "$0.001",
    summary: "Always fails, on purpose",
    description:
      "Always fails on purpose. Proves the rule: the payment is only settled when the handler succeeds, so a broken endpoint costs the buyer nothing.",
    preview: { hint: "this route always returns 500 after payment is verified; your payment is never settled" },
    alwaysFails: true,
  },
];

const ADDRESS: QueryParam = { name: "address", type: "string", description: "A 0x address on Arc.", example: "0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74", required: true };
const URL_PARAM: QueryParam = { name: "url", type: "string", description: "A public http(s) URL, on the default port.", example: "https://www.arc.network", required: true };
const LANG: QueryParam = { name: "lang", type: "string", description: "Wikipedia language code. Defaults to en.", example: "en" };
const DATE: QueryParam = { name: "date", type: "string", description: "A past date as YYYY-MM-DD. Defaults to the latest rates." };

/**
 * Routes that answer from outside our database: Arc read live, and public sources returned as one
 * clean shape. Handlers live in tools.ts.
 */
const TOOL_ROUTES: readonly PaidRoute[] = [
  {
    path: "/v1/paid/arc/wallet",
    group: "Arc, read live",
    plain: { label: "What an Arc address holds", explain: "The USDC and CRA balance of any address on Arc, how many transactions it has sent, and whether it is a person's wallet or a contract. Read from the chain at the moment you ask." },
    price: "$0.002",
    summary: "Balances, transaction count and account type of an Arc address",
    description: "USDC and CRA balances, transactions sent and account type (wallet or contract) for any Arc address, read from the latest block.",
    params: [ADDRESS],
  },
  {
    path: "/v1/paid/arc/token",
    group: "Arc, read live",
    plain: { label: "The facts about a token on Arc", explain: "Give the address of a token and get its name, its ticker, its decimals and how many exist in total. Read from the contract itself, not from a listing site." },
    price: "$0.002",
    summary: "Name, symbol, decimals and total supply of an ERC-20 on Arc",
    description: "Name, symbol, decimals and total supply of any ERC-20 on Arc, read from the contract at the latest block.",
    params: [{ ...ADDRESS, description: "The token contract on Arc.", example: "0x70857041Fef0CED97F9e01E7Ccc21889AFe3F6F4" }],
  },
  {
    path: "/v1/paid/arc/tx",
    group: "Arc, read live",
    plain: { label: "What happened in an Arc transaction", explain: "Paste a transaction hash and get it explained: whether it worked, who sent it to whom, what it cost in fees, and every token that moved inside it, with amounts you can read." },
    price: "$0.003",
    summary: "Status, parties, fee and decoded token transfers of an Arc transaction",
    description: "Status, sender, recipient, fee in USDC and every ERC-20 transfer in an Arc transaction, with symbols and human-readable amounts.",
    params: [{ name: "hash", type: "string", description: "A transaction hash on Arc.", example: "0x903a75fb579f4f6eb6b7ffb90ff3f7de405f117e9aed78d1f21c23a0f1fa0250", required: true }],
  },
  {
    path: "/v1/paid/web/extract",
    group: "The web",
    plain: { label: "The readable text of any web page", explain: "Give a link and get back the title, the description, the headings and the clean text of the page, without menus, scripts and ads. It is what an AI needs to read a page." },
    price: "$0.005",
    summary: "Title, description, headings and clean text of a public URL",
    description: "Title, description, headings and up to 20,000 characters of clean readable text from any public URL. Built for LLM context. Private and local addresses are refused.",
    params: [URL_PARAM],
  },
  {
    path: "/v1/paid/web/check",
    group: "The web",
    plain: { label: "Is this website up, and how fast", explain: "Give a link and get whether the site answers, how long it took, every redirect on the way, and which security settings it has or lacks." },
    price: "$0.002",
    summary: "Status, redirect chain, response time and security headers of a URL",
    description: "HTTP status, redirect chain with timings, total response time and security headers present or missing, for any public URL, measured from our server.",
    params: [URL_PARAM],
  },
  {
    path: "/v1/paid/packages/npm",
    group: "Packages",
    plain: { label: "The state of an npm package", explain: "For any JavaScript package: the latest version and when it came out, its licence, how many downloads a week, what it depends on, and whether its authors have marked it as abandoned." },
    price: "$0.002",
    summary: "Latest version, licence, downloads, dependencies and deprecation of an npm package",
    description: "Latest version, publish date, licence, weekly downloads, dependencies, engines and deprecation status of an npm package.",
    params: [{ name: "name", type: "string", description: "Package name, scoped or not.", example: "hono", required: true }],
  },
  {
    path: "/v1/paid/packages/pypi",
    group: "Packages",
    plain: { label: "The state of a Python package", explain: "For any Python package: the latest version, which Python it needs, its licence, what it depends on, and the known security problems of that version." },
    price: "$0.002",
    summary: "Latest version, Python requirement, licence, dependencies and advisories of a PyPI project",
    description: "Latest version, Python requirement, licence, dependencies and the advisories against the current release of a PyPI project.",
    params: [{ name: "name", type: "string", description: "Project name on PyPI.", example: "requests", required: true }],
  },
  {
    path: "/v1/paid/packages/vulns",
    group: "Packages",
    plain: { label: "Known security holes in a package", explain: "Name a package, and a version if you want, and get the known security problems: how serious each one is and which version fixes it. For checking before you install." },
    price: "$0.004",
    summary: "Known advisories for a package or one exact version",
    description: "Known advisories for a package, or for one exact version, with severity and the versions that fix them. npm, PyPI, Go, crates.io, Maven, RubyGems, NuGet, Packagist.",
    params: [
      { name: "name", type: "string", description: "Package name.", example: "lodash", required: true },
      { name: "ecosystem", type: "string", description: "npm (default), pypi, go, crates.io, maven, rubygems, nuget, packagist.", example: "npm" },
      { name: "version", type: "string", description: "One exact version. Without it, every version ever published.", example: "4.17.20" },
    ],
  },
  {
    path: "/v1/paid/domains/dns",
    group: "Domains",
    plain: { label: "Where a domain name points", explain: "The live records of a domain: which servers it points to, where its mail goes, its text records, and whether its answers are cryptographically signed." },
    price: "$0.001",
    summary: "Live DNS records with TTLs and DNSSEC status",
    description: "Live DNS records for a host name, with TTLs and whether the answers validated under DNSSEC. ?type= takes a comma-separated list of A, AAAA, CNAME, MX, TXT, NS, SOA, CAA.",
    params: [
      { name: "name", type: "string", description: "Host name.", example: "cra-agent.tech", required: true },
      { name: "type", type: "string", description: "Record types, comma-separated. Defaults to A,AAAA,CNAME,MX,TXT,NS." },
    ],
  },
  {
    path: "/v1/paid/domains/whois",
    group: "Domains",
    plain: { label: "Who registered a domain, and until when", explain: "For any domain: the company it was registered through, when it was created, when it expires, and its name servers. If nobody owns it, it says the name looks free." },
    price: "$0.003",
    summary: "Registrar, dates, name servers and availability of a domain",
    description: "Registrar, creation and expiry dates, status codes and name servers of a domain from the registry's RDAP record, and whether the name looks available.",
    params: [{ name: "domain", type: "string", description: "A registrable domain name.", example: "cra-agent.tech", required: true }],
  },
  {
    path: "/v1/paid/currency/rates",
    group: "Currencies",
    plain: { label: "Official exchange rates between currencies", explain: "The reference rates the European Central Bank publishes each working day, against the currency you choose, for today or any past date. About thirty currencies." },
    price: "$0.001",
    summary: "ECB reference rates against a base currency, today or on a past date",
    description: "European Central Bank reference rates against a base currency, latest or on a past date. A daily reference, not an executed price: for that see /v1/paid/fx/execution.",
    params: [
      { name: "base", type: "string", description: "Three-letter currency code. Defaults to USD.", example: "USD" },
      { name: "symbols", type: "string", description: "Only these currencies, comma-separated.", example: "EUR,GBP,JPY" },
      DATE,
    ],
  },
  {
    path: "/v1/paid/currency/convert",
    group: "Currencies",
    plain: { label: "Convert an amount between two currencies", explain: "An amount in one currency turned into another at the official reference rate, for today or any past date. For an agent that prices in dollars and has to show euros." },
    price: "$0.001",
    summary: "Convert an amount at the ECB reference rate",
    description: "Convert an amount between two currencies at the European Central Bank reference rate, latest or on a past date.",
    params: [
      { name: "from", type: "string", description: "Three-letter currency code.", example: "USD", required: true },
      { name: "to", type: "string", description: "Three-letter currency code.", example: "EUR", required: true },
      { name: "amount", type: "string", description: "The amount to convert.", example: "100", required: true },
      DATE,
    ],
  },
  {
    path: "/v1/paid/wiki/search",
    group: "Wikipedia",
    plain: { label: "Search Wikipedia", explain: "The Wikipedia articles that best match a few words, each with a one-line description and a short excerpt. The first step when an AI has to look something up." },
    price: "$0.001",
    summary: "Best matching Wikipedia articles for a query",
    description: "The best matching Wikipedia articles for a query, with descriptions and excerpts, as clean JSON. Content is CC BY-SA 4.0.",
    params: [{ name: "q", type: "string", description: "What to search for.", example: "stablecoin", required: true }, { name: "limit", type: "integer", description: "1 to 20, default 5.", example: 5 }, LANG],
  },
  {
    path: "/v1/paid/wiki/summary",
    group: "Wikipedia",
    plain: { label: "A Wikipedia article in a paragraph", explain: "The opening summary of one Wikipedia article in plain text, with its main image and the date it was last edited." },
    price: "$0.001",
    summary: "Short plain-text summary of one article",
    description: "A short plain-text summary of one Wikipedia article, with its image and last update. Content is CC BY-SA 4.0.",
    params: [{ name: "title", type: "string", description: "Article title.", example: "Stablecoin", required: true }, LANG],
  },
  {
    path: "/v1/paid/wiki/article",
    group: "Wikipedia",
    plain: { label: "A whole Wikipedia article as plain text", explain: "The full text of one Wikipedia article, up to 20,000 characters, with no markup. Ready to hand to an AI as background." },
    price: "$0.003",
    summary: "Full plain text of an article, up to 20,000 characters",
    description: "The full plain text of a Wikipedia article, up to 20,000 characters, ready for LLM context. Content is CC BY-SA 4.0.",
    params: [{ name: "title", type: "string", description: "Article title.", example: "Stablecoin", required: true }, LANG],
  },
];

/** Our own data first, then the tools, and the route that fails on purpose last. */
export const PAID_ROUTES: readonly PaidRoute[] = [...DATA_ROUTES.filter((r) => !r.alwaysFails), ...TOOL_ROUTES, ...DATA_ROUTES.filter((r) => r.alwaysFails)];

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
  { path: "/v1/bazaar", summary: "Everything payable on Arc, by seller", description: "The sellers and categories search covers, with how many endpoints each has, their price range and the API families they sell: our routes, the CRA market and Circle's x402 catalogue. The page is cra-agent.tech/bazaar." },
  { path: "/v1/think/latest", summary: "The thinking agent, live", description: "The run of the agent that pays for its own thinking that is happening now, step by step with the call that is out, or else the last one: every thought paid to its brain, every search, every tool bought, what each cost and the settlement id. The page is cra-agent.tech/think." },
  { path: "/v1/think/runs", summary: "Past runs of the thinking agent", description: "Recent runs with their question, outcome and bill, and the totals. Runs are started by us and paid from our own agent wallet: a demonstration, not customers. One run in full: /v1/think/runs/{id}.", params: [{ name: "limit", type: "integer", description: "How many runs, 1 to 50.", example: 20 }] },
  { path: "/v1/lightning", summary: "Our routes, paid in bitcoin over Lightning", description: "The paid routes again under /v1/lightning, paid with x402's exact scheme on lnbtc: a 402 carries a fresh BOLT11 invoice from our node, bound to the request; pay it and send the preimage. Lists the routes, their dollar prices, the BTC/USD rate they are converted at and our node's key." },
  { path: "/v1/labels", summary: "Address labels by source", description: "How many addresses each public source names (Circle's x402 catalogue, the CRA market, our own, the ERC-8004 registry, public facilitators) and when each was last read. Look one address up at /v1/labels/{address}." },
  { path: "/v1/payments/direct/services", summary: "Known sellers reached by direct payments", description: "Payees that a public source names as a seller (Circle's catalogue, the CRA market, the ERC-8004 registry, our own), with the direct payments each received and from how many distinct payers. Sellers paid only through Circle Gateway settle in batches and do not appear." },
  { path: "/v1/payments/direct", summary: "Direct payments on Arc", description: "Payments made by signed authorization (EIP-3009) on Arc, as our collector indexes them: totals, the last 24 hours, per day, and the relayers that submit them. Raw activity from the chain, not demand: self-payment and one funder behind many payers are not told apart yet." },
  { path: "/v1/selftest", summary: "Hourly self-test of the rail", description: "Our own wallet buying our own endpoint every hour, plus the endpoint that must fail without charging. Not customer activity." },
  {
    path: "/v1/market/search",
    summary: "Find paid APIs on Arc",
    description: "Search our routes, every endpoint on the CRA market (each checked to answer 402 on Arc) and the endpoints Circle's x402 catalogue lists as payable on Arc. Returns the method and URL to call with example parameters, where each parameter goes, the price, what it sells, who is paid and who listed it.",
    params: [
      { name: "q", type: "string", description: "What you need, in a few words.", example: "bitcoin price" },
      { name: "maxPriceUsd", type: "string", description: "Only results at or under this price per call." },
      { name: "limit", type: "integer", description: "1 to 50, default 10.", example: 10 },
    ],
  },
  { path: "/v1/health", summary: "Service health", description: "503 when the collector is stalled or lagging behind the chain head." },
];
