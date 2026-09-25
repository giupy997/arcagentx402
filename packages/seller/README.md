# @cra-agent/seller

Put a USDC price on an API route. Any x402 buyer can pay it, and the payment is settled only after your handler succeeds, so a broken endpoint never charges anyone.

```bash
npm i @cra-agent/seller
```

## One command, no code

You already run an API. This stands in front of it and charges for it:

```bash
npx -y @cra-agent/seller --target https://api.example.com --pay-to 0xYourWallet --price 0.002
```

A caller who has not paid gets `402 Payment Required` with the price; a caller who has paid gets your API's answer, untouched. A call your API fails is not charged. The process never holds a key.

| Option | Meaning |
|---|---|
| `--target <url>` | The API to sell. Can be private or on localhost. |
| `--pay-to <address>` | The wallet that gets paid, on Arc. |
| `--pay-to-solana <address>` | Also sell to buyers on Solana, where most x402 buyers are: they pay USDC on Solana, to this address. Settled by PayAI's open facilitator. |
| `--price <usd>` | Price of every call. |
| `--route "<pattern>=<usd>"` | Price of one path, repeatable: `--route "GET /v1/render/*=0.05"`. Checked before `--price`. |
| `--free <pattern>` | A path served without payment, repeatable. |
| `--name`, `--description` | Shown to buyers and in directories. |
| `--upstream-header "Name: value"` | Added to requests sent to your API, e.g. its own key. Never sent back to buyers. |
| `--network`, `--port` | `arc` (default) or `arcTestnet`; port 8402 by default. |
| `--facilitator cra` | Settle through the CRA facilitator instead of Circle Gateway: browser wallets can then pay you, and it pays the gas. The `--pay-to` wallet registers once, with a signature, at [cra-agent.tech/register](https://cra-agent.tech/register); each wallet gets 200 settlements a day. |
| `--list <public-url>` | Once running, add this public https address to the [CRA market](https://cra-agent.tech/market). |
| `--pay-to-lightning <file>` | Also sell in sats over Lightning, paid to your own node. The file holds a receive-only Nostr Wallet Connect string (in Alby Hub, a connection with the Read Only permissions). See below. |

What is for sale is published, free to read, at `/.well-known/x402`. Payments settle through Circle Gateway and add up in the Gateway balance of `--pay-to`; collect them with `cra-agent withdraw <usdc>` from [`@cra-agent/mcp`](https://www.npmjs.com/package/@cra-agent/mcp). [CRA Factory](https://cra-agent.tech/factory#sell) writes the command for you.

### Paid in sats, on your own node

With `--pay-to-lightning`, every 402 also offers x402 `exact` on `lnbtc` ([the scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_lnbtc.md)), next to Arc and Solana. The offer carries a fresh invoice from your node for the route's dollar price in sats, at the BTC/USD rate of the moment (the median of Coinbase, Kraken and Bitstamp) and at least 1 sat. The invoice's description hash commits to the request: its method, URL and body. A buyer pays it and retries with the preimage. The proof is checked and claimed once before the call goes to your API.

- The connection string is a secret. It stays in a file only you can read (`chmod 600`), and the command refuses it on the command line.
- The command reaches your node before it starts, and stops if the connection can pay, cannot create invoices, or is on a network other than mainnet or testnet.
- Your node needs inbound capacity, and must sign invoices with a description hash. Alby Hub does on its default LDK backend.
- Settled proofs are remembered in `~/.cra-agent/lnbtc-replay.jsonl` (or `CRA_LNBTC_REPLAY_FILE`), so a proof works once, even across restarts. Run one process per file.
- Lightning is paid up front, as the scheme has it. If your API then fails, the sats are already yours: there is no refund on Lightning.
- New invoices are limited to 30 a minute per client address and 600 a minute in all. A browser gets the paywall page without one. If your node takes more than 5 seconds, the 402 goes out with the other rails only.
- The invoice is bound to the URL the buyer called. A reverse proxy in front must pass the public host, in `Host` or `X-Forwarded-Host`, and `X-Forwarded-Proto`.

## Hono

```ts
import { Hono } from "hono";
import { createSeller } from "@cra-agent/seller";

const app = new Hono();
const seller = createSeller({ sellerAddress: "0xYourAddress", network: "arc", serviceName: "My data" })
  .route("GET /v1/forecast", "$0.001", { description: "Weather forecast, per call" });

app.use("/v1/*", seller.middleware());
app.get("/v1/forecast", (c) => c.json({ tomorrow: "sunny" }));
```

## Express

```ts
import { createExpressSeller } from "@cra-agent/seller/express";

const seller = createExpressSeller({ sellerAddress: "0xYourAddress", network: "arc" })
  .route("GET /v1/forecast", "$0.001");
app.use(seller.middleware());
```

## Options per route

| Option | Meaning |
|---|---|
| `description` | Shown to buyers in the 402 and in discovery catalogues. |
| `preview` | Body returned next to the 402 to a caller who has not paid. |
| `inputSchema` / `outputExample` | What the route takes and returns, for discovery. |
| `maxTimeoutSeconds` | How long the buyer's authorization stays valid. |

## Getting listed

Discovery catalogues are filled by the facilitator that settles a payment, and no facilitator settles Arc except Circle's, which does not catalogue. Pass `discovery: { payTo, facilitatorUrl }` to offer the same route on Base at the same price through a facilitator that does. The Arc rail is untouched.

`network` is `arc` or `arcTestnet`. Prices use the x402 money syntax, `"$0.001"`.

## Part of CRA AGENT

Payments for AI agents on [Arc](https://arc.io), Circle's USDC-native L1. Site: [cra-agent.tech](https://cra-agent.tech) · Source: [github.com/giupy997/arcagentx402](https://github.com/giupy997/arcagentx402) · MIT
