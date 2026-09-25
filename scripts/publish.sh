#!/usr/bin/env bash
# Publish the @cra-agent packages to npm in dependency order, as the npm account cra-agent and no other.
# Auth: an `npm login`, or a granular token in ~/.npm-cra-token (or $NPM_TOKEN_FILE), written into a
# temporary npmrc that is deleted on exit. The token is never printed.
# A version already on npm is skipped, so a run that stopped halfway can be run again as it is.
# Usage: scripts/publish.sh [--dry-run]
set -euo pipefail
cd "$(dirname "$0")/.."

token_file="${NPM_TOKEN_FILE:-$HOME/.npm-cra-token}"
if ! npm whoami >/dev/null 2>&1 && [ -s "$token_file" ]; then
  rc="$(mktemp)"
  trap 'rm -f "$rc"' EXIT
  chmod 600 "$rc"
  printf '//registry.npmjs.org/:_authToken=%s\n' "$(tr -d '[:space:]' < "$token_file")" > "$rc"
  export NPM_CONFIG_USERCONFIG="$rc"
fi
who="$(npm whoami 2>/dev/null)" || { echo "not logged in: run 'npm login', or put a token in $token_file"; exit 1; }
[ "$who" = "cra-agent" ] || { echo "logged in to npm as $who: these packages are published only as cra-agent"; exit 1; }

npm run -s build
for p in accounting policy ledger identity lightning router escrow seller mcp; do
  v="$(node -p "require('./packages/$p/package.json').version")"
  if [ "$(npm view "@cra-agent/$p@$v" version 2>/dev/null || true)" = "$v" ]; then
    echo "==> @cra-agent/$p@$v is already on npm, skipped"
    continue
  fi
  echo "==> @cra-agent/$p@$v"
  npm publish -w "@cra-agent/$p" --access public ${1:-}
done
