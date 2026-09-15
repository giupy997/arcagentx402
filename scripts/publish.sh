#!/usr/bin/env bash
# Publish the @cra-agent packages to npm in dependency order. Needs `npm login` first.
# Usage: scripts/publish.sh [--dry-run]
set -euo pipefail
cd "$(dirname "$0")/.."
npm whoami >/dev/null 2>&1 || { echo "not logged in: run 'npm login' first"; exit 1; }
npm run -s build
for p in accounting policy ledger identity router escrow seller mcp; do
  echo "==> @cra-agent/$p"
  npm publish -w "@cra-agent/$p" --access public ${1:-}
done
