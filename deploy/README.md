# Deploying the collector and the API

Server requirements: 4 vCPU, 8 GB RAM. Disk depends on the collector mode, measured on Arc testnet at
roughly 17 transactions per block:

| Mode | Per block | Per day |
|---|---|---|
| `light` (default) | ~2 KB | ~0.5 GB |
| `full` (raw transactions, receipts, logs) | ~75 KB | 12-16 GB |

Start with `light`. `full` is worth it only when you need transaction-level data, and then plan the disk
accordingly.

## On a VPS that already runs Caddy (recommended)

```bash
ssh root@<vps>
curl -fsSL https://raw.githubusercontent.com/giupy997/arcagentx402/main/deploy/setup.sh | DOMAIN=api.example.com bash
# without DOMAIN the site is served on http://<ip>:8081
nano /opt/cra-agent/.env && systemctl restart cra-agent-collector cra-agent-api
journalctl -u cra-agent-collector -f
```

The script is idempotent: it installs Node 22, Postgres 17, a system user, the repository in
`/opt/cra-agent`, systemd units for the collector and the API, and a Caddy site. It keeps an existing
`.env` and database.

## Launch checklist

1. Read <https://docs.arc.io/arc/references/connect-to-arc> and
   <https://docs.arc.io/arc/references/contract-addresses>.
2. Put the chain id and the RPC URLs in `.env`. Use at least two providers besides the public endpoint,
   with the API keys ready in advance.
3. Set `COLLECTOR_START_BLOCK=0` and `COLLECTOR_BACKFILL_HISTORY=1`.
4. Start, then check the log for `endpoint verified` on every URL and for `database bound to chain`.
5. Watch `/health`: `head.lag` should fall to zero and `gapsOpen` should stay at zero.

## Docker

An alternative to the bare-metal script, for a server that has nothing else on it:

```bash
cd deploy
cp ../.env.example .env   # set POSTGRES_PASSWORD and DATABASE_URL=postgres://arc:<pw>@db:5432/arc_rail
docker compose up -d --build
curl -s localhost:8790/health
```

## The thinking agent (cra-agent.tech/think)

`cra-agent-think.service` runs `cra-agent think --record` once: it answers the next question of
`think-questions.txt`, paying its brain and its tools from a wallet of its own, and the page shows the run
live from `think_runs` (migration 014, applied when the collector starts). The timer runs it every 30
minutes, each time a question it has not asked recently: `think-questions.txt` combines templates with lists
of coins, stocks, companies, chains and topics into about 500 questions. Its policy lets it pay only BlockRun
(thoughts, stock prices, Polymarket) and Exa (web search), a cent a payment and two dollars a day, and
`think-tools.txt` lists what it may call; DexScreener is free. Our own API is left out, so our wallet never shows up as usage. A run starts only when Circle Gateway
holds its whole budget, so an empty wallet skips runs instead of failing them. Nothing spends until you enable
it. The questions and the tools are read from the repository at each run; a change to the service file needs
`cp deploy/cra-agent-think.service /etc/systemd/system/ && systemctl daemon-reload`.

```bash
# its own key, made on the server and never shown: prints only the address
sudo -u craagent bash -lc "cd /opt/cra-agent && node packages/mcp/dist/cli/rail.js init --client terminal --network arc --key-file /opt/cra-agent/.secrets/think.key --policy daily=2,per_seller=1.5,per_payment=0.01"
# send USDC on Arc to that address (a week of runs is about $8), then move most of it into Circle Gateway
sudo -u craagent bash -lc "cd /opt/cra-agent && CRA_NETWORK=arc CRA_KEY_FILE=/opt/cra-agent/.secrets/think.key CRA_AGENT_ID=think node packages/mcp/dist/cli/rail.js deposit 10"
# one run now, then every 30 minutes
cp deploy/cra-agent-think.service deploy/cra-agent-think.timer /etc/systemd/system/ && systemctl daemon-reload
systemctl start cra-agent-think.service && journalctl -u cra-agent-think -n 30 --no-pager
systemctl enable --now cra-agent-think.timer
```

A run costs two to three cents: about $1.15 a day on the timer, $35 a month. Check what is left with
`cra-agent balance` under the same key; `systemctl disable --now cra-agent-think.timer` stops it.

## Lightning (x402 exact on lnbtc)

Our routes are also sold under `/v1/lightning/…`, paid in bitcoin: the 402 carries a fresh invoice from our
node, bound to the request, and the paid retry is settled (preimage checked, payment hash claimed once in
`lnbtc_settlements`, migration 015) before it is served. The node is Alby Hub in Docker on this host, its web
interface on 127.0.0.1:8080 only (reach it with `ssh -N -L 8080:127.0.0.1:8080 root@<host>`). The API talks to
it over Nostr Wallet Connect with a receive-only connection:

```bash
# in /opt/cra-agent/.env
LIGHTNING_NWC_FILE=/opt/cra-agent/.secrets/nwc-receive
```

Prices are each route's dollar price in millisatoshis at the median BTC/USD of Coinbase, Kraken and Bitstamp,
rounded up to a whole sat (Alby Hub makes no invoice for a fraction of one), at least `LIGHTNING_MIN_MSAT` (1 sat by default); an invoice lasts 300 seconds. `/v1/lightning`
lists the routes, the rate and our node's key. An agent pays with `cra-agent pay <url> --lightning` when
`CRA_NWC_PAY_FILE` holds a connection that can pay.

The same checks are open to every seller as a facilitator: `POST /facilitator/settle` with an `lnbtc` body is
answered by the API itself, without registration, and anything else still goes to the Arc facilitator.
`/facilitator/supported` lists both. Claims share `lnbtc_settlements` with our own routes and are pruned
hourly, a day after they stop mattering; what the facilitator settled for others is counted in
`facilitator_lnbtc` (migration 016, applied when the collector starts: restart it with the API on this
deploy) and shown at `/v1/facilitator/lightning`. Limits, in `.env` if the defaults do not fit:

```bash
LNBTC_FACILITATOR_MAX_TIMEOUT=3600   # invoices that last longer are refused, so every claim can be pruned
LNBTC_FACILITATOR_PER_MINUTE=60      # settle calls per client address
LNBTC_FACILITATOR_DAILY_CAP=20000    # settlements for everyone per UTC day
# LNBTC_FACILITATOR=off              # to close it
```

## Backups

```bash
pg_dump -Fc arc_rail > arc_rail_$(date +%F).dump
```

Daily, copied off the server. Live observations (finality latency, per-provider RPC behaviour) cannot be
re-fetched from the chain.
