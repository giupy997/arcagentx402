# arc-rail

Rail di pagamento agentico su Arc (L1 di Circle, gas in USDC). Monorepo TypeScript, npm workspaces, Node 22.

Stato: **Fase 0 — collettore dati dal blocco zero.** Vedi `docs/arc-verification.md` per cosa è stato
verificato contro docs.arc.io e cosa resta da confermare al lancio mainnet (16/09/2026).

## Package

| Package | Cosa |
|---|---|
| `packages/accounting` | Unico modulo che fa aritmetica su USDC. Tipi branded `Usdc6` (ERC-20) / `Usdc18` (gas). Test di proprietà |
| `packages/collector` | Collettore: blocchi, tx, receipt, log, deploy, revert, base fee, osservazioni di testa per RPC. Postgres append-only con raw JSON |
| `packages/api` | API di lettura sul DB del collettore (Hono). `/v1/network`, `/v1/fees`, `/v1/fees/estimate`, `/v1/activity`, `/v1/deploys`, `/v1/rpc`, `/v1/health`. Serve anche il sito. In fase 1 diventa il lato venditore (stesse rotte, a pagamento via x402) |
| `packages/web` | Sito: landing (`/`) e dashboard live (`/dashboard`). HTML/CSS/TS senza framework, grafici SVG |

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
- **Health**: `GET :8790/health` (JSON, 503 se in ritardo/stallo), `GET :8790/metrics` (Prometheus).
- **Alert**: log + Telegram (opzionale) su lag > N blocchi, stallo, tutti gli RPC giù, troppi gap.

Stato dal DB: `npm run status -w @arc-rail/collector`.

## Deploy

`deploy/setup.sh` installa tutto su un VPS Ubuntu con Caddy (Node 22, Postgres 17, systemd, sito Caddy).
Vedi `deploy/README.md`.

## Regole del repo

- Nessuna aritmetica su importi USDC fuori da `packages/accounting`.
- Nessun deploy mainnet senza conferma esplicita.
- Chiavi/API key solo in `.env` (gitignorato), mai in chat o nel codice.
