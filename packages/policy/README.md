# @cra-agent/policy

Spend control for an agent that pays. A pure function: give it the policy and the facts, get back allow or the rule that refused. No I/O, no clock, easy to test.

```bash
npm i @cra-agent/policy
```

```ts
import { evaluatePolicy, parsePolicyString } from "@cra-agent/policy";

const policy = parsePolicyString("daily=5,per_seller=0.5,per_payment=0.05,rate=120/60s,deny=evil.example");
const decision = evaluatePolicy(policy, ctx); // { allow: true } or { allow: false, rule, reason }
```

| Key | Meaning |
|---|---|
| `daily` | USDC per rolling day |
| `per_seller` | USDC per day to one counterparty |
| `per_payment` | USDC for a single payment |
| `rate` | `120/60s`: payments per window |
| `allow` / `deny` | Hosts or addresses separated by `\|`. `allow=*` lifts the allowlist. |
| `networks` | CAIP-2 ids the agent may pay on |
| `identity` | `required` to pay only ERC-8004 verified sellers |
| `bond` | Minimum seller bond |

Unknown keys are an error, not a silent default. Amounts are `Usdc6` from `@cra-agent/accounting`, never floats.

## Part of CRA AGENT

Payments for AI agents on [Arc](https://arc.io), Circle's USDC-native L1. Site: [cra-agent.tech](https://cra-agent.tech) · Source: [github.com/giupy997/arcagentx402](https://github.com/giupy997/arcagentx402) · MIT
