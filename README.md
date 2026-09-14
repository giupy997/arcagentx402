# CRA AGENT

[![ci](https://github.com/giupy997/arcagentx402/actions/workflows/ci.yml/badge.svg)](https://github.com/giupy997/arcagentx402/actions/workflows/ci.yml)

Rail di pagamento agentico su Arc (L1 di Circle, gas in USDC). Monorepo TypeScript, npm workspaces, Node 22.

Stato: fase 0 (collettore) fatta; **fase 1 (agente x402) in corso**: quote → policy → identità →
nanopagamento via Circle Gateway → ledger, esposto come server MCP. Vedi `docs/arc-verification.md`
per cosa è verificato contro docs.arc.io e cosa resta da confermare al lancio mainnet (16/09/2026).

## Package

| Package | Cosa |
|---|---|
| `packages/accounting` | Unico modulo che fa aritmetica su USDC. Tipi branded `Usdc6` (ERC-20) / `Usdc18` (gas). Test di proprietà |
| `packages/collector` | Collettore: blocchi, tx, receipt, log, deploy, revert, base fee, osservazioni di testa per RPC. Postgres append-only con raw JSON |
| `packages/api` | API di lettura sul DB del collettore (Hono). `/v1/network`, `/v1/fees`, `/v1/fees/estimate`, `/v1/activity`, `/v1/deploys`, `/v1/rpc`, `/v1/health`. Serve anche il sito. In fase 1 diventa il lato venditore (stesse rotte, a pagamento via x402) |
| `packages/web` | Sito: landing sul prodotto (`/`) e pagina rete live (`/network`). HTML/CSS/TS senza framework, grafici SVG |
| `packages/policy` | Controllo spesa, puro: cap per pagamento / giorno / controparte, rate limit, allow/deny, identità richiesta, gancio bond (fase 2). Sintassi `daily=5,per_seller=0.5,...` |
| `packages/ledger` | Ogni tentativo di pagamento (quoted/rejected/signed/settled/failed) con importo, controparte, latenza, tx. `MemoryLedger` e `PgLedger`; `exposure()` per controparte |
| `packages/identity` | Firma con schema esplicito (`secp256k1` oggi, PQ riservato) e risoluzione ERC-8004 (fail closed) |
| `packages/router` | Il binario compratore: `rail.quote(url)`, `rail.fetch(url)` con x402 + Circle Gateway (batched, gas-free) o `exact` on-chain; `chooseRail()` pura (nanopagamento vs escrow) |
| `packages/seller` | `createSeller().route("GET /x", "$0.001")` su Hono: 402 x402 verificato e regolato da Circle Gateway |
| `packages/mcp` | Server MCP (stdio): `arc_quote`, `arc_pay`, `arc_balance`, `arc_deposit`, `arc_ledger`, `arc_policy`. CLI `npm run rail -- pay <url>` |

## Setup

```bash
nvm use            # Node 22
npm install
cp .env.example .env   # poi modifica DATABASE_URL / ARC_RPC_URLS
npm test
npm run db:migrate
npm run collector
npm run web:build && npm run api   # http://localhost:8791
```

Postgres locale (Homebrew, keg-only):

```bash
LC_ALL=en_US.UTF-8 /opt/homebrew/opt/postgresql@17/bin/pg_ctl -D /opt/homebrew/var/postgresql@17 -l /opt/homebrew/var/postgresql@17/server.log start
```

## Collettore

- **Head worker**: segue la testa (poll ogni 250ms), ingest in batch (2 chiamate JSON-RPC per blocco:
  blocco completo + tutti i receipt), cursore contiguo salvato in `collector_state`.
- **Backfill worker**: se il DB non parte da 0, backfilla da 0 in parallelo a bassa priorità; riempie
  i buchi lasciati dalla testa (`block_gaps`). Si ferma da solo quando la testa è in ritardo.
- **Scanner**: ogni 10 min cerca buchi numerici e rotture di continuità `parent_hash` (mai auto-fix).
- **Probe**: ogni 5s chiede `latest/finalized/safe` a ogni endpoint → `head_observations`
  (dataset lag/latenza per provider) e valuta gli alert.
- **Enrich**: motivo dei revert via `eth_call` al blocco padre; hash/size del bytecode dei deploy.
- **Startup guard**: ogni endpoint deve rispondere il chain id atteso e lo stesso hash di genesi; il DB
  si lega alla genesi e rifiuta chain diverse.
- **Modalità**: `COLLECTOR_MODE=light` (default consigliato: blocchi, statistiche per blocco per tipo di operazione,
  deploy, osservazioni RPC; ~0,4 GB/giorno) o `full` (anche tx, receipt, log e revert; 12-16 GB/giorno).
- **Health**: `GET :8790/health` (JSON, 503 se in ritardo/stallo), `GET :8790/metrics` (Prometheus).
- **Alert**: log + Telegram (opzionale) su lag > N blocchi, stallo, tutti gli RPC giù, troppi gap.

Stato dal DB: `npm run status -w @cra-agent/collector`.

## Agente x402 in locale

```bash
# .env: CRA_NETWORK=arcTestnet, CRA_KEY_FILE=.secrets/agent.key (chmod 600), CRA_POLICY=...
npm run rail -- policy
npm run rail -- quote http://localhost:8791/v1/paid/fees/forecast
npm run rail -- deposit 1      # USDC dal wallet al saldo Gateway (serve USDC di testnet dal faucet Circle)
npm run rail -- pay   http://localhost:8791/v1/paid/fees/forecast
npm run rail -- ledger
npm run mcp                    # server MCP su stdio
```

Il venditore si attiva con `SELLER_ADDRESS` nel `.env`: l'API espone `/v1/paid/*` a pagamento (catalogo su `/v1/paid`).

## Deploy

`deploy/setup.sh` installa tutto su un VPS Ubuntu con Caddy (Node 22, Postgres 17, systemd, sito Caddy).
Vedi `deploy/README.md`.

## Test e migrazioni

- `npm test`: 53 test (vitest) in `packages/*/test`: proprietà sull'accounting (fast-check), parser dei blocchi,
  failover del pool RPC, policy di spesa, scelta del binario, firma. La CI li esegue a ogni push, insieme a un
  test di round-trip del ledger su Postgres reale.
- Migrazioni: `packages/collector/sql/NNN_*.sql`, applicate in ordine da `packages/collector/src/db/migrate.ts`
  (tabella `schema_migrations`), automaticamente all'avvio del collettore o con `npm run db:migrate`.
  Il ledger ha le sue in `packages/ledger/sql`, applicate da `PgLedger.migrate()`.

## Regole del repo

- Nessuna aritmetica su importi USDC fuori da `packages/accounting`.
- Nessun deploy mainnet senza conferma esplicita.
- Chiavi/API key solo in `.env` (gitignorato), mai in chat o nel codice.
