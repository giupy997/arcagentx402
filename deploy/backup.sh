#!/usr/bin/env bash
# Nightly copy of what cannot be rebuilt: the database (payments on /status, the market, the thinking
# agent's runs, Lightning's replay store) and the Lightning node's data. Keeps the newest seven of each.
#
# Run by cra-agent-backup.timer as root: it needs Postgres and Docker. Files are readable by root only.
# The node's copy is for losing the server, never for rolling a running node back: see deploy/README.md.
set -euo pipefail

DEST="${BACKUP_DIR:-/var/backups/cra-agent}"
KEEP="${BACKUP_KEEP:-7}"
DB="${BACKUP_DB:-cra_mainnet}"
NODE="${BACKUP_NODE_CONTAINER:-albyhub}"
NODE_DATA="${BACKUP_NODE_DATA:-/opt/albyhub/data}"
stamp="$(date -u +%Y%m%dT%H%MZ)"

umask 077
install -d -m 700 "$DEST"

# 1. Postgres, in pg_dump's custom format: compressed, and restorable table by table.
sudo -u postgres pg_dump -Fc "$DB" > "$DEST/$DB-$stamp.dump.part"
mv "$DEST/$DB-$stamp.dump.part" "$DEST/$DB-$stamp.dump"

# 2. The Lightning node, frozen for the seconds the copy takes, so its files agree with each other.
#    Paused, not stopped: nothing restarts, and it is unpaused whatever happens to the copy.
if docker inspect "$NODE" >/dev/null 2>&1; then
  docker pause "$NODE" >/dev/null
  trap 'docker unpause "$NODE" >/dev/null 2>&1 || true' EXIT
  tar -C "$(dirname "$NODE_DATA")" -czf "$DEST/$NODE-$stamp.tgz.part" "$(basename "$NODE_DATA")"
  docker unpause "$NODE" >/dev/null
  trap - EXIT
  mv "$DEST/$NODE-$stamp.tgz.part" "$DEST/$NODE-$stamp.tgz"
fi

# 3. The newest $KEEP of each kind stay; a copy cut short by a crash (.part) never counts.
for kind in "$DB" "$NODE"; do
  find "$DEST" -maxdepth 1 -name "$kind-*" ! -name "*.part" -printf "%T@ %p\n" | sort -rn | tail -n +"$((KEEP + 1))" | cut -d" " -f2- | xargs -r rm -f
done
find "$DEST" -maxdepth 1 -name "*.part" -mmin +120 -delete

echo "backup $stamp done:"
find "$DEST" -maxdepth 1 -name "*-$stamp.*" -printf "  %f %s bytes\n"
