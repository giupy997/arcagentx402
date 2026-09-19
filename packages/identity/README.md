# @cra-agent/identity

Three small things an agent rail needs on Arc.

```bash
npm i @cra-agent/identity
```

**A signer with an explicit scheme.** `createSigner({ scheme: "secp256k1", privateKey })`. The scheme is a parameter on purpose: post-quantum signing is reserved and throws today rather than pretending.

**ERC-8004 identity, failing closed.** `createErc8004Resolver({ network, rpcUrl })` answers whether an address holds an agent identity. Any error means "not verified". The registry is live on Arc testnet and has no bytecode on mainnet yet.

**An RPC endpoint that is answering.**

```ts
import { pickRpcUrl, mergeRpcLists, PUBLIC_RPCS, CHAIN_IDS } from "@cra-agent/identity";

const url = await pickRpcUrl(mergeRpcLists(["https://my-node.example"], PUBLIC_RPCS.arc), CHAIN_IDS.arc);
```

Candidates are tried at once and the highest-priority healthy one wins. Healthy means the right chain id and a head that keeps up with the others. The public list is ordered by failures we measured over 24 hours, because all four endpoints pass a liveness check while some of them refuse calls.

## Part of CRA AGENT

Payments for AI agents on [Arc](https://arc.io), Circle's USDC-native L1. Site: [cra-agent.tech](https://cra-agent.tech) · Source: [github.com/giupy997/arcagentx402](https://github.com/giupy997/arcagentx402) · MIT
