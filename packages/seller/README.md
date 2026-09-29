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
| `--lightning-facilitator <url\|cra>` | Have Lightning proofs checked and remembered by this x402 facilitator instead of a file on your machine. `cra` is ours: open to anyone, no registration, free. |

What is for sale is published, free to read, at `/.well-known/x402`. Payments settle through Circle Gateway and add up in the Gateway balance of `--pay-to`; collect them with `cra-agent withdraw <usdc>` from [`@cra-agent/mcp`](https://www.npmjs.com/package/@cra-agent/mcp). [CRA Factory](https://cra-agent.tech/factory#sell) writes the command for you.

### Moving what you earn on Solana to Arc

With `--pay-to-solana`, buyers on Solana pay you there. One command moves that USDC to your wallet on Arc:

```bash
npx -y @cra-agent/seller sweep --solana-key-file ./solana.key --to 0xYourArcWallet --dry-run
```

It asks [Eco Routes](https://eco.com) for a quote. You deposit the USDC into Eco's Portal on Solana, a solver burns it with Circle's CCTP V2 with Arc as the destination, and it is minted to your Arc address a few seconds later. Nobody holds it in between.

Nothing is signed until the quote says exactly what was asked: the amount, your Arc address as the recipient, a fee under the cap, Eco's program, your wallet as the only signer, and inside it a CCTP burn to Arc's domain (26) for your address. `--dry-run` stops after those checks and a simulation. Without it, the command sends, then waits until the USDC shows up on Arc.

| Option | Meaning |
|---|---|
| `--solana-key-file <path>` | The Solana wallet's key: a 32-byte seed in hex, or the JSON array `solana-keygen` writes. Keep it readable only by you. |
| `--to <0x…>` | Your wallet on Arc. |
| `--amount <usdc>` | How much to move. All of it by default. |
| `--max-fee <usdc>` | Refuse a quote whose fee is higher. Default: 0.01 USDC or 0.5% of the amount, whichever is more. Eco charges about 0.02% today. |
| `--dry-run` | Check and simulate only. |

The wallet needs a little SOL for the network fee.

### Paid in sats, on your own node

With `--pay-to-lightning`, every 402 also offers x402 `exact` on `lnbtc` ([the scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_lnbtc.md)), next to Arc and Solana. The offer carries a fresh invoice from your node for the route's dollar price in sats, at the BTC/USD rate of the moment (the median of Coinbase, Kraken and Bitstamp), rounded up to a whole sat and at least 1. The invoice's description hash commits to the request: its method, URL and body. A buyer pays it and retries with the preimage. The proof is checked and claimed once before the call goes to your API.

- The connection string is a secret. It stays in a file only you can read (`chmod 600`), and the command refuses it on the command line.
- The command reaches your node before it starts, and stops if the connection can pay, cannot create invoices, or is on a network other than mainnet or testnet.
- Your node needs inbound capacity, and must sign invoices with a description hash. Alby Hub does on its default LDK backend.
- Settled proofs are remembered in `~/.cra-agent/lnbtc-replay.jsonl` (or `CRA_LNBTC_REPLAY_FILE`), so a proof works once, even across restarts. Run one process per file.
- Or, with `--lightning-facilitator cra`, [our facilitator](https://api.cra-agent.tech/v1/facilitator/lightning) checks each proof and remembers it: useful with several servers in front of one node, which must share one record. Keep the same choice for a node, because the file and the facilitator do not see each other's proofs. If the facilitator does not answer at start, the command stops rather than switch to the file.
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

## Billed by use (x402 `upto`)

When a call's cost is known only once it is done, the buyer signs for a ceiling and you take what the call cost. It needs a facilitator that settles `upto` on Arc: the CRA one does, once your `sellerAddress` is registered at [cra-agent.tech/register](https://cra-agent.tech/register).

```ts
import { charge, createSeller } from "@cra-agent/seller";

const seller = createSeller({ sellerAddress: "0xYourAddress", network: "arc", settlement: "direct", facilitatorUrl: "https://api.cra-agent.tech/facilitator" })
  .route("GET /v1/render", "$0.10", { upto: true, maxTimeoutSeconds: 300 });

app.use("/v1/*", seller.middleware());
app.get("/v1/render", async (c) => {
  const job = await render(c.req.query("scene"));
  charge(c, `$${job.costUsd}`); // what this call cost, at most the ceiling
  return c.json(job.result);
});
```

The buyer signs once: a Permit2 authorization for the ceiling, which only the facilitator it names can settle, with an EIP-2612 permit for Arc's USDC, so there is no approval transaction and no gas on their side. A handler that fails takes nothing; one that never calls `charge` takes the whole ceiling. Arc only: the Base and Solana rails sell set prices. [CRA Think](https://cra-agent.tech/think#hire) is sold this way.

## Options per route

| Option | Meaning |
|---|---|
| `description` | Shown to buyers in the 402 and in discovery catalogues. |
| `preview` | Body returned next to the 402 to a caller who has not paid. |
| `inputSchema` / `outputExample` | What the route takes and returns, for discovery. |
| `maxTimeoutSeconds` | How long the buyer's authorization stays valid. |
| `upto` | Bill by use: the price is the ceiling, and the handler says what the call cost with `charge()`. Needs `settlement: "direct"`. |

## Getting listed

Discovery catalogues are filled by the facilitator that settles a payment, and no facilitator settles Arc except Circle's, which does not catalogue. Pass `discovery: { payTo, facilitatorUrl }` to offer the same route on Base at the same price through a facilitator that does. The Arc rail is untouched.

`network` is `arc` or `arcTestnet`. Prices use the x402 money syntax, `"$0.001"`.

## Part of CRA AGENT

Payments for AI agents on [Arc](https://arc.io), Circle's USDC-native L1. Site: [cra-agent.tech](https://cra-agent.tech) · Source: [github.com/giupy997/arcagentx402](https://github.com/giupy997/arcagentx402) · MIT
