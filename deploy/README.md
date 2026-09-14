# Deploy del collettore

Requisiti server: 4 vCPU, 8 GB RAM, **disco: misurato su testnet ~95 KB/blocco con ~18 tx/blocco
(raw JSON di tx e receipt inclusi) → ~16 GB/giorno a 0.5 s/blocco.** Mainnet al lancio potrebbe
essere più o meno denso: partire con **1 TB NVMe**, monitorare `pg_database_size` dal giorno 1.
Se serve tagliare: il raw dei receipt duplica i log (tabella `logs`); è la prima cosa da comprimere,
ma NON prima di aver visto i dati reali.

## Docker (consigliato)

```bash
git clone <repo> /opt/arc-rail && cd /opt/arc-rail/deploy
cp ../.env.example .env
# nel .env: ARC_NETWORK=mainnet, ARC_RPC_URLS=<endpoint mainnet verificati>, ARC_CHAIN_ID=<da docs.arc.io>,
# DATABASE_URL=postgres://arc:<pw>@db:5432/arc_rail, POSTGRES_PASSWORD=<pw>, TELEGRAM_*
docker compose up -d --build
curl -s localhost:8790/health
docker compose logs -f collector
```

## Checklist lancio (16/09)

1. Leggere https://docs.arc.io/arc/references/connect-to-arc e https://docs.arc.io/arc/references/contract-addresses.
2. Mettere chain id + URL RPC nel `.env`. Almeno 2 provider oltre al pubblico (chiavi API pronte prima).
3. `COLLECTOR_START_BLOCK=0`, `COLLECTOR_BACKFILL_HISTORY=1`.
4. Avviare; verificare nel log `endpoint verified` per ogni URL e `database bound to chain`.
5. Guardare `/health`: `head.lag` deve scendere a ~0; `gapsOpen` deve restare 0.
6. Se la chain era già viva prima del lancio pubblico, il backfill da 0 parte da solo: `backfill.cursor` cresce.

## Backup

`pg_dump -Fc arc_rail > arc_rail_$(date +%F).dump` giornaliero, copiato fuori dal server. Il dato dei
primi blocchi non si ricompra.
