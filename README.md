# CRA AGENT

[![ci](https://github.com/giupy997/arcagentx402/actions/workflows/ci.yml/badge.svg)](https://github.com/giupy997/arcagentx402/actions/workflows/ci.yml)

Payments for AI agents on [Arc](https://arc.io), Circle's USDC-native L1. One tool call and an agent can
buy an API call for a fraction of a cent: the rail reads the [x402](https://x402.org) price, applies a
spending policy the model cannot change, verifies the seller, pays gas-free through Circle Gateway, and
writes the receipt to a ledger.

TypeScript monorepo, npm workspaces, Node 22. Site: [cra-agent.tech](https://cra-agent.tech).

Status: the buyer agent, the seller middleware and the MCP server are built and exercised end to end on
Arc testnet. See `docs/arc-verification.md` for every value verified against docs.arc.io.

## Packages

| Package | What it does |
|---|---|
| `packages/accounting` | The only module allowed to do arithmetic on USDC amounts. Branded types `Usdc6` (ERC-20 interface) and `Usdc18` (native/gas interface), dust-preserving conversions, property tests |
| `packages/policy` | Pure spend control: caps per payment, per day and per counterparty, rate limit, allow/deny lists, required identity, seller-bond hook. Compact syntax `daily=5,per_seller=0.5,…` |
| `packages/ledger` | Every payment attempt (quoted / rejected / signed / settled / failed) with amount, counterparty, latency and transaction. `MemoryLedger` and `PgLedger`; `exposure()` per counterparty |
| `packages/identity` | Signing with an explicit scheme parameter (`secp256k1` today, post-quantum reserved) and ERC-8004 resolution, fail closed. `registerIdentity()` mints the agent identity |
| `packages/router` | The buyer rail: `rail.quote(url)` and `rail.fetch(url)` over x402 with Circle Gateway batched settlement (gas-free) or the standard on-chain `exact` scheme. `chooseRail()` is pure: nanopayment vs escrow |
| `packages/escrow` | The ERC-8183 rail for jobs: createJob, setBudget, fund (with USDC approval), submit, complete/reject, claimRefund. ABI taken from the verified implementation on chain; the evaluator is injected |
| `packages/seller` | `createSeller().route("GET /x", "$0.001")` for Hono, `createExpressSeller()` for Express. Payments verified and settled by Circle Gateway; any x402 buyer can pay |
| `packages/collector` | Block-zero collector: blocks, per-block stats by operation, contract deploys, base fee inputs, per-provider RPC observations. Optionally transactions, receipts, logs and revert reasons. Append-only Postgres with the raw JSON-RPC preserved |
| `packages/api` | Read API over the collector database (Hono): `/v1/network`, `/v1/fees`, `/v1/fees/estimate`, `/v1/activity`, `/v1/deploys`, `/v1/rpc`, `/v1/fx`, `/v1/token`, `/v1/health`, plus the paid `/v1/paid/*` routes. Also serves the website |
| `packages/web` | The site: product landing (`/`), live network page (`/network`) and token page (`/token`, price, burns and payouts). Plain HTML, CSS and TypeScript, hand-drawn SVG charts |
| `packages/mcp` | MCP server over stdio: `arc_quote`, `arc_pay`, `arc_balance`, `arc_deposit`, `arc_ledger`, `arc_policy`, plus the escrow tools `arc_job_create`, `arc_job_fund`, `arc_job_status`, `arc_job_decide`, `arc_job_submit`. Also a CLI |

## Setup

```bash
nvm use            # Node 22
npm install
cp .env.example .env   # then set DATABASE_URL and ARC_RPC_URLS
npm test
npm run db:migrate
npm run collector
npm run web:build && npm run api   # http://localhost:8791
```

Local Postgres (Homebrew, keg-only):

```bash
LC_ALL=en_US.UTF-8 /opt/homebrew/opt/postgresql@17/bin/pg_ctl -D /opt/homebrew/var/postgresql@17 -l /opt/homebrew/var/postgresql@17/server.log start
```

## The agent

```bash
# .env: CRA_NETWORK=arc, CRA_KEY_FILE=.secrets/agent.key (chmod 600), CRA_POLICY=…
npm run rail -- policy
npm run rail -- quote https://api.cra-agent.tech/v1/paid/fees/forecast
npm run rail -- deposit 1      # wallet USDC into the Gateway balance
npm run rail -- pay   https://api.cra-agent.tech/v1/paid/fees/forecast
npm run rail -- ledger
npm run mcp                    # MCP server on stdio

npm run rail -- identity-register https://cra-agent.tech/.well-known/agent.json   # ERC-8004, costs gas
npm run rail -- job status 1                                                      # ERC-8183
```

As an MCP server, for any MCP client:

```json
{ "mcpServers": { "cra-agent": {
    "command": "cra-agent-mcp",
    "env": {
      "CRA_NETWORK": "arc",
      "CRA_KEY_FILE": "/etc/cra-agent/agent.key",
      "CRA_POLICY": "daily=5,per_seller=0.5,per_payment=0.05,identity=required"
    }
} } }
```

The policy is read from the environment, not from the conversation: the model cannot raise its own limit,
and never sees the key.

## Selling

```ts
import { createSeller } from "@cra-agent/seller";

const seller = createSeller({ sellerAddress, network: "arc" })
  .route("GET /v1/forecast", "$0.001", { description: "Weather forecast, per call" });

app.use(seller.middleware());   // Hono; createExpressSeller() for Express
```

Setting `SELLER_ADDRESS` in `.env` turns on our own paid routes: the API then serves `/v1/paid/*`
(catalogue at `/v1/paid`) priced per call.

## Two guarantees worth knowing

- **A broken endpoint costs the buyer nothing.** x402's default flow verifies the payment, runs the
  handler, and settles only if it succeeded. Our own API exposes `GET /v1/paid/selftest/fail`, a priced
  route that always answers 500, so anyone can check it: the response is 500, the receipt reads
  `not_charged`, and the Gateway balance does not move.
- **Every settled payment ends with a transaction anyone can check.** Circle Gateway settles in batches,
  so the transfer reaches the seller after the response. `cra-agent proof` (MCP: `arc_proof`) matches
  settled payments to the on-chain USDC transfer that carried them and stores the hash in the ledger.

## Collector

- **Head worker**: follows the chain head (250 ms poll), ingests in batches (two JSON-RPC calls per block:
  the full block and all its receipts), keeps a contiguous cursor in `collector_state`.
- **Backfill worker**: fills the history down to block zero and any gap the head left behind, at low
  priority; it pauses whenever the head worker falls behind.
- **Scanner**: every 10 minutes, looks for numeric holes and `parent_hash` discontinuities. Never auto-fixes.
- **Probe**: every 5 seconds asks every endpoint for `latest`, `finalized` and `safe`, storing
  `head_observations` (per-provider lag and latency) and evaluating alerts.
- **Enrich**: revert reasons by replaying failed transactions with `eth_call` against the parent block;
  runtime bytecode size and hash for deploys.
- **Startup guard**: every endpoint must report the expected chain id and the same genesis hash; the
  database binds itself to that genesis and refuses any other chain.
- **Prices**: for every watched pair (EURC, and the project token when `TOKEN_ADDRESS` is set) it
  records each swap against USDC at the rate it executed. Transfers are netted per pair of
  addresses, so a token that taxes transfers is priced correctly, and a hop that merely forwarded
  what it was handed is skipped instead of guessed. Served at `/v1/fx?symbol=` and, with the size
  curve and venues, at `/v1/paid/fx/execution`.
- **Modes**: `COLLECTOR_MODE=light` (default: blocks, per-block stats by operation, deploys, RPC
  observations, around 0.5 GB/day) or `full` (also transactions, receipts, logs and reverts).
- **Health**: `GET :8790/health` (JSON, 503 when lagging or stalled), `GET :8790/metrics` (Prometheus).
- **Alerts**: log plus optional Telegram on lag, stall, all RPCs down, open gaps, low disk.

Database summary: `npm run status -w @cra-agent/collector`.

## Deploy

`deploy/setup.sh` installs everything on an Ubuntu VPS running Caddy (Node 22, Postgres 17, systemd units
for the collector and the API, a Caddy site). See `deploy/README.md`.

## Tests and migrations

- `npm test` runs the vitest suites in `packages/*/test`: property tests on the accounting module
  (fast-check), block parsing, RPC pool failover, spend policy, rail choice, signing, escrow mapping.
  CI runs them on every push together with a ledger round-trip against a real Postgres.
- Migrations live in `packages/collector/sql/NNN_*.sql` and are applied in order by
  `packages/collector/src/db/migrate.ts` (table `schema_migrations`), automatically when the collector
  starts or via `npm run db:migrate`. The ledger has its own in `packages/ledger/sql`, applied by
  `PgLedger.migrate()`.

## Publishing

```bash
npm login
scripts/publish.sh --dry-run   # then without the flag
```

## House rules

- No arithmetic on USDC amounts outside `packages/accounting`.
- No mainnet deployment without explicit confirmation.
- Keys and API keys only in `.env` (git-ignored) or a file with `chmod 600`, never in chat or in code.

## License

MIT.
