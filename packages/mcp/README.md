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
| `arc_search` | Finds what can be bought on Arc from a few words ("bitcoin price", "web search"): CRA AGENT's own data, the CRA market, and the endpoints Circle's x402 catalogue lists as payable on Arc (Exa, Goldsky, BlockRun and others). Each result: the method and the URL with example parameters, where each parameter goes (query, path or JSON body), the price, the seller, who listed it, and whether your policy allows paying it now. Free. |
| `arc_quote` | Reads the price of a URL and says whether the policy would allow it. Pays nothing. For a POST, pass the body the payment will carry: some sellers check it before they name a price. |
| `arc_pay` | Pays for the URL and returns the response with a receipt. With `lightning: true` it pays in bitcoin over Lightning when the seller's 402 offers it (x402 exact on lnbtc), from the wallet in `CRA_NWC_PAY_FILE`, under the same limits in dollars. Limits are checked on what the 402 asks at pay time, before anything is signed. `maxUsdc` adds a ceiling for that one call: pass the price `arc_search` listed, and a seller who raised it since is refused even inside your limits. |
| `arc_balance` | Wallet and Circle Gateway balances. |
| `arc_deposit` | Moves wallet USDC into the Gateway balance. Needed once before the first payment. |
| `arc_ledger` | Every attempt: quoted, rejected, signed, settled, failed. |
| `arc_proof` | Matches settled payments to the on-chain transfer that carried them. |
| `arc_verify_receipt` | Checks a signed receipt from another agent: who signed it, and whether the payment fitted the limits it states. |
| `arc_policy` | Shows the limits in force. |
| `arc_job_*` | ERC-8183 escrow jobs. Testnet only until the contract is deployed on Arc mainnet. |

## An agent that pays for its own thinking

`cra-agent think "<task>"` runs a small autonomous agent whose brain is a pay-per-call LLM on Arc: BlockRun's chat completions, found in the bazaar, Claude Haiku 4.5 by default. Every thought is a paid call, and so is every tool the brain asks for: it searches the bazaar for free, then buys what it needs at the listed price. There is no API key anywhere, only the agent's wallet. The session budget (`--budget`, default $0.10) and the spending policy cover thinking and tools alike, a thought is capped with `--ceiling` (default $0.01), and the brain can only buy a URL that one of its searches returned. It prints each step with its cost and ends with the bill: so much for thinking, so much for tools. A short task costs a few cents: the run on [cra-agent.tech/think](https://cra-agent.tech/think) that found when Arc mainnet went live and who validates it cost $0.023648, four thoughts and one web search from Exa.

It also knows a few free public APIs, called without paying and shown as such: DexScreener's pairs, boosted tokens and new token profiles, digested to what answers questions (pairs by 24-hour volume). `--tools <file>` keeps it to a list of URL prefixes: anything else is never shown to it, so never bought.

With `--record` and a `DATABASE_URL`, the run is kept in Postgres as it happens, step by step, which is how the page shows it live and replays it after. `--questions <file>` picks the question when none is given, which is how our server runs it on a timer: the file combines templates (`What is the price of {coin} right now?`) with lists (`@coin = bitcoin (BTC) | ether (ETH)`), and a recorded run never repeats one of the last hundred questions.

The same agent can be hired by anyone, over x402 `upto`: `GET https://api.cra-agent.tech/v1/upto/think?task=…` asks you to sign for up to $0.10 and charges what the run spent plus $0.005. `arc_pay` and `cra-agent pay` pay routes like this one: your policy is checked against the ceiling, since all of it could be taken, and your ledger keeps what was. The default policy allows $0.05 a payment, so give this one more with `per_payment=0.10`.

## Fund the agent from Base or Solana

Paying on Arc takes USDC in Circle Gateway on Arc, and most agents hold theirs on Base or Solana. One command brings it over and deposits it:

```bash
cra-agent fund 5 --from base                                    # from this agent's own wallet on Base, same key and address
cra-agent fund 5 --from solana --solana-key-file ~/sol.json     # from a Solana wallet: our hex seed or solana-keygen's JSON
cra-agent fund 5 --from base --dry-run                          # everything checked, nothing signed
```

It asks [Eco](https://eco.com) for a route, and checks the quote before signing anything, from the transaction's own calldata: a CCTP burn of exactly that amount to Arc's domain, minting to this agent, a fee under the cap (`--max-fee`, default 0.5% or $0.01), the refund to the same wallet. From Base, the vault the USDC goes into must be the one Eco's Portal derives for that intent. It then waits for the USDC on Arc, usually seconds, and deposits it into Gateway, leaving $0.01 in the wallet for Arc's gas (`--keep`, or `--no-deposit` to keep it all in the wallet). From Base the wallet needs a little ETH for two transactions, about a cent; from Solana, a little SOL. The model has no tool for this: moving money between chains is the owner's call, from a terminal.

## The same thing from a terminal

```bash
cra-agent find bitcoin price    # what is for sale on Arc; needs no key (in a browser: cra-agent.tech/bazaar)
cra-agent balance
cra-agent quote https://api.cra-agent.tech/v1/paid/rpc/health
cra-agent quote https://api.exa.ai/search --body '{"query":"x402 on Arc"}'           # the price of a POST, with its body
cra-agent fund 5 --from base   # USDC from Base to this agent on Arc, into Gateway
cra-agent deposit 1
cra-agent withdraw 1            # Gateway balance back to the wallet; how a seller collects
cra-agent pay   https://api.cra-agent.tech/v1/paid/rpc/health
cra-agent pay   https://api.exa.ai/search 0.007 --body '{"query":"x402 on Arc"}'   # a POST, refused above the listed price
cra-agent think "What is x402, in two sentences?" --budget 0.10              # an agent that pays for its own thinking
cra-agent proof
cra-agent verify receipt.json      # needs no key and no network
cra-agent pq-key ~/.cra-agent/pq.key           # a post-quantum key for receipts; prints only its public half
cra-agent verify receipt.json --require-pq --on-arc   # the second signature too, and Arc's own verdict on it
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
| `CRA_BASE_RPC_URL` / `SOLANA_RPC_URL` | Optional, for `fund`: the Base and Solana endpoints. Public ones by default. |
| `DATABASE_URL` | Optional Postgres for the ledger. Without it the ledger lives in memory. |
| `CRA_PQ_KEY_FILE` | Optional, the file `cra-agent pq-key` made. Every receipt is then signed a second time with SLH-DSA-SHA2-128s, the post-quantum scheme Arc verifies on chain. It covers the receipt, not the payment, and adds about a second to each one. |

Two things worth knowing. A payment is settled only after the seller's handler succeeds, so a failing endpoint costs nothing: `https://api.cra-agent.tech/v1/paid/selftest/fail` always answers 500 so you can check. And `identity=required` pays only sellers with an ERC-8004 identity on Arc: the address that gets paid must own an agent in the registry, or be the wallet an agent declared for payments. It proves an identity exists, not that the seller is honest; registering costs only gas.

## Part of CRA AGENT

Payments for AI agents on [Arc](https://arc.io), Circle's USDC-native L1. Site: [cra-agent.tech](https://cra-agent.tech) · Source: [github.com/giupy997/arcagentx402](https://github.com/giupy997/arcagentx402) · MIT
