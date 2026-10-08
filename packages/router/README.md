# @cra-agent/router

The buyer rail. It answers a 402 for you: reads the price, asks the spending policy before anything is signed, pays in USDC on Arc through Circle Gateway, and writes what happened to a ledger.

```bash
npm i @cra-agent/router @cra-agent/identity @cra-agent/policy @cra-agent/ledger
```

```ts
import { createRail } from "@cra-agent/router";
import { createSigner } from "@cra-agent/identity";
import { parsePolicyString } from "@cra-agent/policy";
import { MemoryLedger } from "@cra-agent/ledger";

const signer = createSigner({ scheme: "secp256k1", privateKey });
const rail = createRail({
  network: "arc",
  signer,
  policy: parsePolicyString("daily=5,per_seller=0.5,per_payment=0.05"),
  ledger: new MemoryLedger(),
  identity: null,
  agentId: signer.address,
  rpcUrl: "https://rpc.blockdaemon.mainnet.arc.io",
});

const quote = await rail.quote(url);      // price and policy verdict, nothing paid
const { response, receipt } = await rail.fetch(url); // pays; receipt is null when the URL was free
const proofs = await rail.resolveSettlements(); // receipts matched to on-chain transfers
```

Every receipt carries `budget` (the caps in force, what had been spent, what is left) and `attestation`, the same facts signed with the agent's key. Anyone can check one offline:

```ts
import { verifySpendReceipt } from "@cra-agent/router";
const { valid, signer, withinStatedLimits } = await verifySpendReceipt(receipt.attestation, expectedAgent);
```

The signature proves the agent's key issued the statement and that nothing was changed since. It is the rail vouching for itself; the settlement on chain is the independent part.

### A second, post-quantum signature

A receipt is meant to be checked years from now, and the wallet's secp256k1 signature is the kind a large quantum computer could forge. So a receipt can be signed a second time with SLH-DSA-SHA2-128s (FIPS 205), the scheme [Arc verifies on chain](https://docs.arc.io/arc/concepts/post-quantum-security) with its PQ Signature Verify precompile. Both signatures are over the same EIP-712 digest, and a receipt that carries both is valid only when both hold.

```ts
import { createRail, newPostQuantumSeed, postQuantumKey, receiptDigest, verifiedByArc, verifySpendReceipt } from "@cra-agent/router";

const rail = createRail({ ...config, postQuantum: postQuantumKey(seed) }); // seed: 48 bytes, kept like a private key
const { receipt } = await rail.fetch(url);

await verifySpendReceipt(receipt.attestation, agent, { requirePostQuantum: true }); // offline
await verifiedByArc(receipt.attestation.postQuantum, receiptDigest(receipt.attestation), rpcUrl); // a read-only call to Arc
```

What it covers: the receipt, not the payment. A payment on Arc is authorised by the wallet key until Arc has post-quantum transaction signing. The SLH-DSA key is tied to the agent by a statement the wallet key signs, so publish the public key where it gets a date if the tie has to outlive secp256k1. Signing takes about a second and adds 16 KB to a receipt, which is why it is off unless you give the rail a key.

A policy rejection never reaches the signer: it is recorded in the ledger with the rule that stopped it. A seller whose handler fails is recorded as `quoted`, not charged. `chooseRail()` is pure and decides between a nanopayment and ERC-8183 escrow by amount and kind.

The buyer needs a Gateway balance first: `await rail.deposit("1")`.

## Part of CRA AGENT

Payments for AI agents on [Arc](https://arc.io), Circle's USDC-native L1. Site: [cra-agent.tech](https://cra-agent.tech) · Source: [github.com/giupy997/arcagentx402](https://github.com/giupy997/arcagentx402) · MIT
