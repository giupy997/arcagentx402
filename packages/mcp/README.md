# @cra-agent/mcp

An MCP server that lets an AI agent pay for an API call. The agent calls one tool, the rail reads the [x402](https://x402.org) price, checks a spending policy, pays in USDC on Arc through Circle Gateway with no gas for the buyer, and keeps the receipt.

The model never sees the key, and it cannot raise its own limit: both are read from the environment before the conversation starts.

## Install

```bash
npm i -g @cra-agent/mcp
```

## Set it up in one command

```bash
cra-agent init --client claude-desktop
```

Creates the agent's key in `~/.cra-agent/agent.key` (readable only by you, never overwritten), checks the limits, writes the entry into the client's config file with a copy of the old one, and prints the address to fund. `--client` is `claude-desktop`, `cursor`, `claude-code` or `terminal`; `--policy`, `--network`, `--key-file` and `--dry-run` do what they say. [CRA Factory](https://cra-agent.tech/factory) writes the command for you from four questions.

## Or by hand, from any MCP client

```json
{ "mcpServers": { "cra-agent": {
    "command": "cra-agent-mcp",
    "env": {
      "CRA_NETWORK": "arc",
      "CRA_KEY_FILE": "/path/to/agent.key",
      "CRA_POLICY": "daily=5,per_seller=0.5,per_payment=0.05"
    }
} } }
```

`CRA_KEY_FILE` points at a file holding the private key, `chmod 600`. Never put a key in a prompt.

## Tools

| Tool | What it does |
|---|---|
| `arc_search` | Finds what can be bought on Arc from a few words ("bitcoin price"). Each result: the URL with example parameters, the price, the seller, and whether your policy allows paying it now. Free. |
| `arc_quote` | Reads the price of a URL and says whether the policy would allow it. Pays nothing. |
| `arc_pay` | Pays for the URL and returns the response with a receipt. |
| `arc_balance` | Wallet and Circle Gateway balances. |
| `arc_deposit` | Moves wallet USDC into the Gateway balance. Needed once before the first payment. |
| `arc_ledger` | Every attempt: quoted, rejected, signed, settled, failed. |
| `arc_proof` | Matches settled payments to the on-chain transfer that carried them. |
| `arc_verify_receipt` | Checks a signed receipt from another agent: who signed it, and whether the payment fitted the limits it states. |
| `arc_policy` | Shows the limits in force. |
| `arc_job_*` | ERC-8183 escrow jobs. Testnet only until the contract is deployed on Arc mainnet. |

## The same thing from a terminal

```bash
cra-agent find bitcoin price    # what is for sale on Arc; needs no key
cra-agent balance
cra-agent quote https://api.cra-agent.tech/v1/paid/rpc/health
cra-agent deposit 1
cra-agent withdraw 1            # Gateway balance back to the wallet; how a seller collects
cra-agent pay   https://api.cra-agent.tech/v1/paid/rpc/health
cra-agent proof
cra-agent verify receipt.json      # needs no key and no network
```

Every receipt carries the limits the payment passed under and is signed with the agent's key, so someone who was not there can check it. The signature proves the agent issued the statement and nobody changed it; the settlement on chain is the independent half.

## Environment

| Variable | Meaning |
|---|---|
| `CRA_NETWORK` | `arc` (mainnet) or `arcTestnet`. Default `arcTestnet`. |
| `CRA_KEY_FILE` / `CRA_PRIVATE_KEY` | The agent's key. Prefer the file. |
| `CRA_POLICY` | `daily=5,per_seller=0.5,per_payment=0.05,rate=120/60s,allow=a.com\|b.com,deny=c.com` |
| `CRA_RPC_URL` | Optional, one or several separated by commas, in priority order. Tried before the public Arc endpoints. |
| `CRA_RPC_STRICT` | `1` to never fall back to a public endpoint. |
| `DATABASE_URL` | Optional Postgres for the ledger. Without it the ledger lives in memory. |

Two things worth knowing. A payment is settled only after the seller's handler succeeds, so a failing endpoint costs nothing: `https://api.cra-agent.tech/v1/paid/selftest/fail` always answers 500 so you can check. And `identity=required` pays only sellers with an ERC-8004 identity on Arc: the address that gets paid must own an agent in the registry, or be the wallet an agent declared for payments. It proves an identity exists, not that the seller is honest; registering costs only gas.

## Part of CRA AGENT

Payments for AI agents on [Arc](https://arc.io), Circle's USDC-native L1. Site: [cra-agent.tech](https://cra-agent.tech) · Source: [github.com/giupy997/arcagentx402](https://github.com/giupy997/arcagentx402) · MIT
