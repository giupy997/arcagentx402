# @cra-agent/escrow

A client for ERC-8183 AgenticCommerce: money held until work is accepted. For jobs with a deliverable, or amounts too large for a pay-per-call nanopayment.

```bash
npm i @cra-agent/escrow
```

```ts
import { createEscrowClient } from "@cra-agent/escrow";

const escrow = createEscrowClient({ network: "arcTestnet", signer, evaluator });
const { jobId } = await escrow.createJob({ provider, description: "Translate the report", expiresInSeconds: 86_400 });
await escrow.setBudget(jobId, parseUsdc6("5"));   // from @cra-agent/accounting
await escrow.fund(jobId);                          // approves USDC if needed, then funds
await escrow.complete(jobId, "delivered as agreed"); // or reject(jobId, reason), or claimRefund(jobId) after expiry
```

The ABI comes from the verified implementation on chain. **Testnet only for now:** the contract has no bytecode on Arc mainnet, and the client says so instead of guessing an address.

## Part of CRA AGENT

Payments for AI agents on [Arc](https://arc.io), Circle's USDC-native L1. Site: [cra-agent.tech](https://cra-agent.tech) · Source: [github.com/giupy997/arcagentx402](https://github.com/giupy997/arcagentx402) · MIT
