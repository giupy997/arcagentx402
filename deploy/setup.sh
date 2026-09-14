#!/usr/bin/env bash
# One-time (idempotent) setup of cra-agent on an Ubuntu 24.04 VPS that already runs Caddy.
# Installs Node 22 (NodeSource), PostgreSQL 17 (PGDG), a system user, the repo in /opt/cra-agent,
# systemd units for collector + api, and a Caddy site. Safe to re-run: keeps .env and the database.
#
#   curl -fsSL https://raw.githubusercontent.com/giupy997/arcagentx402/main/deploy/setup.sh \
#     | DOMAIN=arc.example.com bash
#
# DOMAIN: hostname whose A record points here (Caddy gets the certificate). Without DOMAIN the site
#         is served on http://<ip>:8081 for a first test (Caddy keeps port 80/443 for whatever it already serves).
set -euo pipefail

REPO="${REPO:-https://github.com/giupy997/arcagentx402.git}"
APP_DIR=/opt/cra-agent
APP_USER=craagent
DOMAIN="${DOMAIN:-}"
DB_NAME=arc_rail
DB_USER=craagent
API_PORT=8791
HEALTH_PORT=8790

[ "$(id -u)" = 0 ] || { echo "Run as root (sudo -i)"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "==> packages"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates gnupg lsb-release >/dev/null

if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 22 ]; then
  echo "==> node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

if ! command -v psql >/dev/null; then
  echo "==> postgresql 17"
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list
  apt-get update -qq
  apt-get install -y -qq postgresql-17 >/dev/null
fi
systemctl enable --now postgresql >/dev/null

echo "==> database"
DB_PASS_FILE=/etc/cra-agent.dbpass
if [ ! -f "$DB_PASS_FILE" ]; then
  # (not `tr </dev/urandom | head`: with pipefail the SIGPIPE on tr aborts the script)
  openssl rand -hex 24 > "$DB_PASS_FILE"
  chmod 600 "$DB_PASS_FILE"
fi
DB_PASS=$(cat "$DB_PASS_FILE")
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1 || sudo -u postgres psql -c "CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS'"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 || sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"
# Write-heavy append-only workload: trade a few seconds of durability for throughput. Data is re-fetchable from RPC.
PGCONF=$(sudo -u postgres psql -tAc "SHOW config_file")
grep -q "^# cra-agent" "$PGCONF" || cat >> "$PGCONF" <<'PG'
# cra-agent
shared_buffers = 2GB
effective_cache_size = 6GB
wal_compression = lz4
max_wal_size = 4GB
checkpoint_completion_target = 0.9
synchronous_commit = off
default_toast_compression = lz4
PG
systemctl restart postgresql

echo "==> user and code"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/$APP_USER --shell /usr/sbin/nologin "$APP_USER"
if [ -d "$APP_DIR/.git" ]; then
  sudo -u "$APP_USER" git -C "$APP_DIR" pull --ff-only
else
  install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR"
  sudo -u "$APP_USER" git clone -q "$REPO" "$APP_DIR"
fi
# --force: a previous failed build leaves tsbuildinfo files that make tsc skip emitting on the next run.
sudo -u "$APP_USER" bash -c "cd $APP_DIR && npm ci --no-audit --no-fund --silent && rm -f packages/*/tsconfig.tsbuildinfo && npm run -s build"

echo "==> env"
if [ ! -f "$APP_DIR/.env" ]; then
  cat > "$APP_DIR/.env" <<ENV
# Filled by deploy/setup.sh on $(date -u +%F). Edit, then: systemctl restart cra-agent-collector cra-agent-api
ARC_NETWORK=testnet
# ARC_CHAIN_ID=5042            # mainnet: confirm on docs.arc.io/arc/references/connect-to-arc first
ARC_RPC_URLS=https://rpc.testnet.arc.io,https://rpc.drpc.testnet.arc.io,https://rpc.quicknode.testnet.arc.io,https://rpc.blockdaemon.testnet.arc.io
# ALCHEMY_ARC_URL=
DATABASE_URL=postgres://$DB_USER:$DB_PASS@127.0.0.1:5432/$DB_NAME
COLLECTOR_MODE=light
COLLECTOR_DISK_ALERT_GB=40
COLLECTOR_START_BLOCK=0
COLLECTOR_BACKFILL_HISTORY=1
COLLECTOR_CONCURRENCY=4
COLLECTOR_BATCH_BLOCKS=20
COLLECTOR_HEALTH_PORT=$HEALTH_PORT
API_PORT=$API_PORT
# TELEGRAM_BOT_TOKEN=
# TELEGRAM_CHAT_ID=
LOG_LEVEL=info
ENV
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "    wrote $APP_DIR/.env (testnet defaults) — edit before switching to mainnet"
fi

echo "==> systemd"
cat > /etc/systemd/system/cra-agent-collector.service <<UNIT
[Unit]
Description=cra-agent collector (Arc block-zero data collector)
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=/usr/bin/node packages/collector/dist/main.js
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=40
LimitNOFILE=65536
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$APP_DIR

[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/cra-agent-api.service <<UNIT
[Unit]
Description=cra-agent api + website
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR/packages/api
EnvironmentFile=$APP_DIR/.env
Environment=WEB_DIR=$APP_DIR/packages/web/dist
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=3
LimitNOFILE=65536
NoNewPrivileges=true
ProtectSystem=strict

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now cra-agent-collector cra-agent-api >/dev/null
systemctl restart cra-agent-collector cra-agent-api

echo "==> caddy"
install -d /etc/caddy/sites
if [ -n "$DOMAIN" ]; then
  cat > /etc/caddy/sites/cra-agent.caddy <<CADDY
$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:$API_PORT
}
CADDY
else
  cat > /etc/caddy/sites/cra-agent.caddy <<CADDY
:8081 {
	encode zstd gzip
	reverse_proxy 127.0.0.1:$API_PORT
}
CADDY
fi
grep -q "import /etc/caddy/sites/\*.caddy" /etc/caddy/Caddyfile || printf '\nimport /etc/caddy/sites/*.caddy\n' >> /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile >/dev/null && systemctl reload caddy

echo "==> done"
sleep 3
systemctl --no-pager --no-legend status cra-agent-collector cra-agent-api | grep -E "Active|●" || true
curl -s "http://127.0.0.1:$HEALTH_PORT/health" | head -c 300; echo
echo "site: ${DOMAIN:+https://$DOMAIN}${DOMAIN:-http://$(curl -s -4 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}'):8081}"
