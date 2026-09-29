# @cra-agent/lane

USDC to [Arc](https://arc.io), from Solana or from Base, through [Eco Routes](https://eco.com) and Circle's CCTP V2. Eco quotes the move and a solver burns the USDC through CCTP with Arc as the destination; it is minted on Arc seconds later, and nobody holds it in between.

A quote is data from a server, so nothing is signed until it says exactly what was asked, read from the transaction itself: the amount, the Arc recipient, a fee under the cap, Eco's program or Portal, the funder as the only signer, the refund to the funder, and inside it a CCTP burn to Arc's domain (26) for that recipient. From Base, the vault the USDC is approved to is the one Eco's Portal derives for the intent, asked of the Portal on chain. Arrival is read on Arc, not taken on trust.

```ts
import { baseLane, solanaLane, readSolanaSigner } from "@cra-agent/lane";

// From Base: the account's own USDC, to an address on Arc. Needs a little ETH on Base for two transactions.
const fromBase = baseLane();
await fromBase.move(account, "0xYourArcAddress", { amount: 5_000_000n, dryRun: true });

// From Solana: needs a little SOL for the transaction fee.
const fromSolana = solanaLane();
await fromSolana.sweep(await readSolanaSigner("/path/to/sol.json"), "0xYourArcAddress", { amount: 5_000_000n });
```

Amounts are micro-USDC. `maxFee` defaults to 0.5% or $0.01, whichever is more; anything a quote says that differs from what was asked throws `SweepRefused`, before any signature.

Used by `cra-agent fund` ([@cra-agent/mcp](https://www.npmjs.com/package/@cra-agent/mcp)) and `cra-agent-sell sweep` ([@cra-agent/seller](https://www.npmjs.com/package/@cra-agent/seller)).

## Part of CRA AGENT

Payments for AI agents on [Arc](https://arc.io), Circle's USDC-native L1. Site: [cra-agent.tech](https://cra-agent.tech) · Source: [github.com/giupy997/arcagentx402](https://github.com/giupy997/arcagentx402) · MIT
