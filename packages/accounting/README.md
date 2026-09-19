# @cra-agent/accounting

On Arc, USDC is both the token and the gas, and it has two faces: 6 decimals as an ERC-20, 18 decimals as the native asset. Mixing them up is off by a trillion. This package makes that a type error.

```bash
npm i @cra-agent/accounting
```

```ts
import { parseUsdc6, formatUsdc6, toUsdc18, splitUsdc18, txFee18, addUsdc6 } from "@cra-agent/accounting";

const price = parseUsdc6("0.001");            // Usdc6, a branded bigint
formatUsdc6(addUsdc6(price, price));          // "0.002"
const { usdc6, dust18 } = splitUsdc18(fee18); // 18 to 6 decimals, the remainder kept rather than dropped
```

`Usdc6` and `Usdc18` are branded bigints, so passing one where the other is expected does not compile. No floats anywhere, and conversions that would lose precision either return the dust or throw. Property-tested.

## Part of CRA AGENT

Payments for AI agents on [Arc](https://arc.io), Circle's USDC-native L1. Site: [cra-agent.tech](https://cra-agent.tech) · Source: [github.com/giupy997/arcagentx402](https://github.com/giupy997/arcagentx402) · MIT
