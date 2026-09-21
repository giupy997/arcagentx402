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
| `--price <usd>` | Price of every call. |
| `--route "<pattern>=<usd>"` | Price of one path, repeatable: `--route "GET /v1/render/*=0.05"`. Checked before `--price`. |
| `--free <pattern>` | A path served without payment, repeatable. |
| `--name`, `--description` | Shown to buyers and in directories. |
| `--upstream-header "Name: value"` | Added to requests sent to your API, e.g. its own key. Never sent back to buyers. |
| `--network`, `--port` | `arc` (default) or `arcTestnet`; port 8402 by default. |
| `--list <public-url>` | Once running, add this public https address to the [CRA market](https://cra-agent.tech/market). |

What is for sale is published, free to read, at `/.well-known/x402`. Payments settle through Circle Gateway and add up in the Gateway balance of `--pay-to`; collect them with `cra-agent withdraw <usdc>` from [`@cra-agent/mcp`](https://www.npmjs.com/package/@cra-agent/mcp). [CRA Factory](https://cra-agent.tech/factory#sell) writes the command for you.

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
