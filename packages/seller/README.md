# @cra-agent/seller

Put a USDC price on an API route. Any x402 buyer can pay it, and the payment is settled only after your handler succeeds, so a broken endpoint never charges anyone.

```bash
npm i @cra-agent/seller
```

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
