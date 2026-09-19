# @cra-agent/ledger

A record of what an agent did with money: every attempt, not only the payments. Statuses are `quoted`, `rejected`, `signed`, `settled`, `failed`, so you can read afterwards where a call stopped and why.

```bash
npm i @cra-agent/ledger
```

```ts
import { MemoryLedger, PgLedger } from "@cra-agent/ledger";

const ledger = new MemoryLedger();
// or
const pg = new PgLedger(process.env.DATABASE_URL!);
await pg.migrate();

await ledger.spentSince(agentId, since);          // Usdc6
await ledger.exposure();                          // open amounts per counterparty: signed, not yet settled
await ledger.recent(agentId, 20);
```

Amounts are stored as `numeric(78,0)` base units, hashes as `bytea`. `settlementTx` and `settledOnchainAt` are filled when a batched payment is matched to its on-chain transfer.

## Part of CRA AGENT

Payments for AI agents on [Arc](https://arc.io), Circle's USDC-native L1. Site: [cra-agent.tech](https://cra-agent.tech) · Source: [github.com/giupy997/arcagentx402](https://github.com/giupy997/arcagentx402) · MIT
