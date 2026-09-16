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

## Backups

```bash
pg_dump -Fc arc_rail > arc_rail_$(date +%F).dump
```

Daily, copied off the server. Live observations (finality latency, per-provider RPC behaviour) cannot be
re-fetched from the chain.
