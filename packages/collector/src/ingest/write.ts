import { withTx, type Db, type Tx } from "../db/index.js";
import type { ParsedBlockBundle } from "./parse.js";

export interface WriteMeta {
  sourceRpc: string;
  fetchMs: number;
  /** Set when the block was fetched at (or right behind) the live head. */
  observedAt: Date | null;
  observedVia: string | null;
}

/** Idempotent: re-writing an existing block is a no-op (ON CONFLICT DO NOTHING everywhere). */
export async function writeBundle(db: Db, bundle: ParsedBlockBundle, meta: WriteMeta): Promise<{ inserted: boolean }> {
  return withTx(db, async (tx) => {
    const b = bundle.block;
    const ins = await tx.query(
      `INSERT INTO blocks (number, hash, parent_hash, "timestamp", miner, gas_limit, gas_used, gas_used_ratio, base_fee_per_gas,
         next_base_fee_per_gas, extra_data, tx_count, size_bytes, state_root, receipts_root, transactions_root, raw,
         observed_at, observed_via, source_rpc, fetch_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (number) DO NOTHING`,
      [
        b.number, b.hash, b.parentHash, b.timestamp, b.miner, b.gasLimit, b.gasUsed, b.gasUsedRatio, b.baseFeePerGas,
        b.nextBaseFeePerGas, b.extraData, b.txCount, b.sizeBytes, b.stateRoot, b.receiptsRoot, b.transactionsRoot, JSON.stringify(b.raw),
        meta.observedAt, meta.observedVia, meta.sourceRpc, meta.fetchMs,
      ],
    );
    if (ins.rowCount === 0) return { inserted: false };
    await writeTxs(tx, bundle);
    await writeReceipts(tx, bundle);
    await writeLogs(tx, bundle);
    await writeDeploys(tx, bundle);
    if (bundle.failedTxHashes.length > 0) {
      await tx.query(
        `INSERT INTO tx_reverts (tx_hash, block_number, replay_status)
         SELECT h, $2, 'pending' FROM unnest($1::bytea[]) AS h ON CONFLICT DO NOTHING`,
        [bundle.failedTxHashes, b.number],
      );
    }
    return { inserted: true };
  });
}

async function writeTxs(tx: Tx, { txs }: ParsedBlockBundle): Promise<void> {
  if (txs.length === 0) return;
  await tx.query(
    `INSERT INTO transactions (block_number, tx_index, hash, "from", "to", value, nonce, gas, gas_price, max_fee_per_gas,
       max_priority_fee_per_gas, tx_type, chain_id, input_selector, input_size, raw, input)
     SELECT * FROM unnest($1::bigint[], $2::int[], $3::bytea[], $4::bytea[], $5::bytea[], $6::numeric[], $7::bigint[], $8::bigint[],
       $9::numeric[], $10::numeric[], $11::numeric[], $12::smallint[], $13::bigint[], $14::bytea[], $15::int[], $16::jsonb[], $17::bytea[])
     ON CONFLICT DO NOTHING`,
    [
      txs.map((t) => t.blockNumber), txs.map((t) => t.txIndex), txs.map((t) => t.hash), txs.map((t) => t.from), txs.map((t) => t.to),
      txs.map((t) => t.value), txs.map((t) => t.nonce), txs.map((t) => t.gas), txs.map((t) => t.gasPrice), txs.map((t) => t.maxFeePerGas),
      txs.map((t) => t.maxPriorityFeePerGas), txs.map((t) => t.txType), txs.map((t) => t.chainId), txs.map((t) => t.inputSelector),
      txs.map((t) => t.inputSize), txs.map((t) => JSON.stringify(t.raw)), txs.map((t) => t.input),
    ],
  );
}

async function writeReceipts(tx: Tx, { receipts }: ParsedBlockBundle): Promise<void> {
  if (receipts.length === 0) return;
  await tx.query(
    `INSERT INTO receipts (tx_hash, block_number, tx_index, status, gas_used, cumulative_gas_used, effective_gas_price, fee_usdc18,
       contract_address, logs_count, raw)
     SELECT * FROM unnest($1::bytea[], $2::bigint[], $3::int[], $4::smallint[], $5::bigint[], $6::bigint[], $7::numeric[], $8::numeric[],
       $9::bytea[], $10::int[], $11::jsonb[])
     ON CONFLICT DO NOTHING`,
    [
      receipts.map((r) => r.txHash), receipts.map((r) => r.blockNumber), receipts.map((r) => r.txIndex), receipts.map((r) => r.status),
      receipts.map((r) => r.gasUsed), receipts.map((r) => r.cumulativeGasUsed), receipts.map((r) => r.effectiveGasPrice), receipts.map((r) => r.feeUsdc18),
      receipts.map((r) => r.contractAddress), receipts.map((r) => r.logsCount), receipts.map((r) => JSON.stringify(r.raw)),
    ],
  );
}

async function writeLogs(tx: Tx, { logs }: ParsedBlockBundle): Promise<void> {
  if (logs.length === 0) return;
  await tx.query(
    `INSERT INTO logs (block_number, log_index, tx_index, tx_hash, address, topic0, topic1, topic2, topic3, data)
     SELECT * FROM unnest($1::bigint[], $2::int[], $3::int[], $4::bytea[], $5::bytea[], $6::bytea[], $7::bytea[], $8::bytea[], $9::bytea[], $10::bytea[])
     ON CONFLICT DO NOTHING`,
    [
      logs.map((l) => l.blockNumber), logs.map((l) => l.logIndex), logs.map((l) => l.txIndex), logs.map((l) => l.txHash), logs.map((l) => l.address),
      logs.map((l) => l.topics[0]), logs.map((l) => l.topics[1]), logs.map((l) => l.topics[2]), logs.map((l) => l.topics[3]), logs.map((l) => l.data),
    ],
  );
}

async function writeDeploys(tx: Tx, { deploys }: ParsedBlockBundle): Promise<void> {
  if (deploys.length === 0) return;
  await tx.query(
    `INSERT INTO contract_deploys (address, deployer, tx_hash, block_number, tx_index, block_timestamp, init_code_size, init_code_hash, success)
     SELECT * FROM unnest($1::bytea[], $2::bytea[], $3::bytea[], $4::bigint[], $5::int[], $6::bigint[], $7::int[], $8::bytea[], $9::boolean[])
     ON CONFLICT DO NOTHING`,
    [
      deploys.map((d) => d.address), deploys.map((d) => d.deployer), deploys.map((d) => d.txHash), deploys.map((d) => d.blockNumber), deploys.map((d) => d.txIndex),
      deploys.map((d) => d.blockTimestamp), deploys.map((d) => d.initCodeSize), deploys.map((d) => d.initCodeHash), deploys.map((d) => d.success),
    ],
  );
}
