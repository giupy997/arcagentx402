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
live from `think_runs` (migration 014, applied when the collector starts). The timer runs it every three
hours. Its policy lets it pay only BlockRun and Exa, a cent a payment and half a dollar a day; our own API
is left out, so our wallet never shows up as usage. Nothing spends until you enable it.

```bash
# its own key, made on the server and never shown: prints only the address
sudo -u craagent bash -lc "cd /opt/cra-agent && node packages/mcp/dist/cli/rail.js init --client terminal --network arc --key-file /opt/cra-agent/.secrets/think.key --policy daily=0.5,per_seller=0.4,per_payment=0.01"
# send a couple of dollars of USDC on Arc to that address, then move most of it into Circle Gateway
sudo -u craagent bash -lc "cd /opt/cra-agent && CRA_NETWORK=arc CRA_KEY_FILE=/opt/cra-agent/.secrets/think.key CRA_AGENT_ID=think node packages/mcp/dist/cli/rail.js deposit 1.5"
# one run now, then every three hours
cp deploy/cra-agent-think.service deploy/cra-agent-think.timer /etc/systemd/system/ && systemctl daemon-reload
systemctl start cra-agent-think.service && journalctl -u cra-agent-think -n 30 --no-pager
systemctl enable --now cra-agent-think.timer
```

A run costs two to three cents: about $0.25 a day on the timer.

## Backups

```bash
pg_dump -Fc arc_rail > arc_rail_$(date +%F).dump
```

Daily, copied off the server. Live observations (finality latency, per-provider RPC behaviour) cannot be
re-fetched from the chain.
