# Verifica del brief contro docs.arc.io — 2026-09-14

Regola zero del brief: vince la documentazione live. Questo file registra cosa è stato verificato,
come, e dove il brief e la realtà divergono. Da ripetere il 16/09 al lancio mainnet.

## Fonti lette

- https://docs.arc.io/llms.txt (indice)
- https://docs.arc.io/arc/references/connect-to-arc.md
- https://docs.arc.io/arc/references/contract-addresses.md
- https://docs.arc.io/arc/references/gas-and-fees.md
- https://docs.arc.io/arc/concepts/stable-fee-design.md
- https://docs.arc.io/arc/references/evm-differences.md
- https://docs.arc.io/arc/concepts/deterministic-finality.md
- https://docs.arc.io/arc/tools/node-providers.md
- https://docs.arc.io/arc/concepts/post-quantum-security.md
- https://docs.arc.io/build/agentic-economy.md
- https://docs.arc.io/arc/tutorials/register-your-first-ai-agent.md
- https://docs.arc.io/arc/tutorials/create-your-first-erc-8183-job.md
- https://www.arc.io/blog/arc-mainnet-goes-live-on-september-16-2026
- Sonde JSON-RPC dirette su `rpc.testnet.arc.io` e sugli endpoint dei provider (vedi sotto)

## Tabella brief vs verificato

| Voce | Brief | Verificato | Esito |
|---|---|---|---|
| Chain ID testnet | 5042002 | `eth_chainId` = 0x4cef52 = 5042002 su tutti e 4 gli endpoint pubblici | ✅ |
| Chain ID mainnet | "sarà diverso, verificalo" | **docs.arc.io non pubblica ancora parametri mainnet.** viem `chains.arc` = 5042; `rpc.blockdaemon.mainnet.arc.io` e `rpc.drpc.mainnet.arc.io` esistono ma rispondono 401 (auth). Il tuo `soltech/arc-bridge/config.js` usava 5042 a luglio. | ⚠️ 5042 è il default nel codice ma **non verificato sui docs**; il collettore lo asserisce a runtime e si rifiuta di partire se l'RPC risponde altro |
| USDC | `0x3600…0000`, 6 dec ERC-20 / 18 dec gas | Confermato su docs (testnet) e on-chain: `decimals()`=6, `symbol()`=USDC, è un proxy. Docs: "two interfaces that share one balance" | ✅ testnet; mainnet: da confermare |
| Block time | ~0.48s | Genesis testnet 2025-09-10, 62.08M blocchi al 2026-09-14 → ~0.51s medio. Docs: 0.5s | ✅ |
| Gas limit blocco | (non nel brief) | 30,000,000 (`0x1c9c380`) | ℹ️ |
| Base fee | ~$0.01 target, EIP-1559 + EWMA | Docs: EIP-1559 con EWMA; **min 20 gwei (floor), max 20.000 gwei**; alpha e target_utilization **non pubblicati**. Osservato: base fee inchiodata a 20 gwei (0x4a817c800) con utilizzo 4–7%. Docs: **la base fee del blocco successivo sta in `extraData` del padre, 8 byte big-endian** — confermato: `0x00000004a817c800` = 20 gwei | ✅ (il collettore salva `next_base_fee_per_gas` da extraData + `gas_used_ratio` per blocco: bastano per stimare alpha/target) |
| Base fee bruciata? | — | Docs evm-differences: **pagata al beneficiario del blocco, non bruciata** | ℹ️ |
| Finalità | deterministica sub-secondo | Docs: Malachite BFT, irreversibile all'inclusione. RPC: tag `finalized` e `safe` funzionano (rispondono ≥ `latest`, cioè non hanno senso come "ritardo"). Nessun metodo dedicato | ✅ — nessuna logica di reorg nel collettore |
| Consenso/esecuzione | Malachite BFT, Reth, Osaka | Docs: Osaka baseline + alcune feature Amsterdam. `web3_clientVersion` = `arc/v1` | ✅ |
| Tx types | — | EIP-1559 e EIP-7702 supportati; **EIP-4844 (type 3) rifiutato** | ℹ️ |
| Log nativi | — | **EIP-7708**: i trasferimenti nativi emettono `Transfer` dall'address di sistema `0xffff…fffe` (osservato nei receipt). Il gas NON emette log | ℹ️ importante per la fase 1 (riconciliazione) |
| Node provider | Alchemy, QuickNode, dRPC, Blockdaemon | Testnet: `rpc.{drpc,quicknode,blockdaemon}.testnet.arc.io` aperti senza chiave; Alchemy richiede key. Mainnet: non pubblicati | ✅ testnet |
| PQ signatures | SLH-DSA-SHA2-128s opt-in | Docs: "beta support" al lancio, opzionale; **nessun dettaglio su encoding/tx type/API** | ✅ (nessuna dipendenza) |
| Nanopayments | `@circle-fin/x402-batching` | npm: v3.4.0 (2026-08-24), peer `@x402/core ^2.3`, `viem ^2`. Supporta `arcTestnet`; **Arc mainnet non nella lista** (ovvio, pre-lancio). Sample repo `circlefin/arc-nanopayments` citato dai docs ma **404** oggi | ⚠️ fase 1: ricontrollare dopo il lancio |
| ERC-8004 | identità | Testnet: Identity `0x8004A818…`, Reputation `0x8004B663…`, Validation `0x8004Cb1B…` | ✅ testnet |
| ERC-8183 | job escrow | Testnet reference `0x0747EEf0…`, stati Open/Funded/Submitted/Completed/Rejected/Expired | ✅ testnet |
| Explorer | Blockscout | `testnet.arcscan.app` | ✅ |
| Roadmap non live | Privacy/APS, Stablecoin Services | Confermato "roadmap" nei docs | ✅ |

## Comportamento RPC osservato (rpc.testnet.arc.io, 2026-09-14)

| Cosa | Risultato |
|---|---|
| Batch JSON-RPC | 200 chiamate `eth_getBlockByNumber(full)` in un batch: OK (8s, 5MB). 100 `eth_getBlockReceipts`: OK (2.2s) |
| `eth_getBlockReceipts` | supportato (una chiamata per blocco invece di N) |
| `eth_getLogs` | max **20.000 risultati** per query (errore -32602 con range suggerito); range > ~10k blocchi → -32012 "requested range too large" |
| `debug_*` / `trace_*` | **non supportati** → i deploy interni (factory/CREATE2) non sono osservabili direttamente; si ricostruiscono dai log delle factory |
| Latenza singola chiamata | 0.15–1.2s (senza keepalive più alta); 30 richieste concorrenti OK |
| Rate limit | nessun 429 osservato a ~30 req/s; Cloudflare davanti (403 con user-agent Python di default) |
| Campi extra | `blockTimestamp` nei tx e nei log (non standard), salvato nel raw |
| dRPC (`rpc.drpc.testnet.arc.io`) | **batch max 3 richieste** (HTTP 500 "Batch of more than 3 requests are not allowed"); il pool lo impara e spezza i batch |
| Pubblico sotto carico | `-32005 rate limit exceeded` a ~4 batch da 40 chiamate in parallelo; il pool mette l'endpoint in cooldown e passa agli altri. Blockdaemon testnet: 0 errori |
| Connessioni | `ETIMEDOUT` sporadici su tutti gli endpoint (Cloudflare/TCP), riassorbiti dai retry |

## Risultati del run di prova (testnet, 2026-09-14, ~2.5 min)

- 740 blocchi, 13.226 tx, 49.922 log, 762 deploy, 857 tx fallite. **0 buchi, 0 rotture di parent hash.**
- `next_base_fee_per_gas` (da extraData) == `base_fee_per_gas` del blocco successivo su **739/739**.
- Fee medie osservate (USDC): trasferimento nativo 0.00043, transfer ERC-20 0.0013, call 0.0041, deploy 0.022.
- Revert decodificati: Error(string) ("Can only mint one Activity NFT per day"), Panic(0x12), custom errors.
  Circa il 2% delle replay "riesce" (revert dipendenti dallo stato/ordine): marcate `succeeded_on_replay`.
- Latenza live (observed_at − block.timestamp): p50 2.0 s, p95 4.1 s (timestamp a granularità di secondo,
  più batch di 20 blocchi; il dato per RPC è in `head_observations`).
- **Storage: 70 MB per 740 blocchi ≈ 95 KB/blocco ≈ 16 GB/giorno** con la densità del testnet. Vedi `deploy/README.md`.


## Divergenze da segnalare (per te, Wayne)

1. **Chain ID mainnet non è nei docs.** Il collettore parte solo se `ARC_CHAIN_ID` (default 5042) coincide
   con `eth_chainId` e se tutti gli endpoint concordano sull'hash del blocco 0. Il DB si lega a quel
   genesis e rifiuta altre chain. Al lancio: leggere connect-to-arc, mettere gli URL in `ARC_RPC_URLS`.
2. **Gli endpoint mainnet dei provider esistono già ma chiedono auth (401).** Il giorno 16 o li aprono
   o servono API key: vanno procurate **prima** (Alchemy, dRPC, Blockdaemon, QuickNode).
3. **Block zero è probabilmente già passato.** A luglio bridgiavi già su chain 5042 (memoria del progetto):
   se il mainnet "pubblico" è la stessa chain, la genesi è di mesi fa. Il collettore gestisce il caso:
   parte dalla testa e backfilla da 0 in parallelo (`backfill` worker), senza buchi.
4. **Traces non disponibili**: "chi deploya cosa" copre i deploy top-level (receipt.contractAddress) e
   i fallimenti (indirizzo CREATE derivato). I deploy via factory si ricavano a posteriori dai log.
5. **Motivo dei revert**: non c'è nei receipt; lo ricaviamo con `eth_call` replay al blocco padre, best
   effort. Serve un RPC con stato storico; altrimenti resta `rpc_error` e si riprova dopo con un archive.
6. **viem**: usato per tipi/keccak; il trasporto JSON-RPC è un client minimale su `fetch`, perché
   serve conservare il JSON grezzo così com'è, batchare 2 chiamate per blocco e gestire il failover
   per-endpoint con consapevolezza del lag, cosa che il `fallback` transport di viem non fa.
