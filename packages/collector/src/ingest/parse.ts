import { hexQuantityToBigInt, toSqlNumeric, txFee18 } from "@cra-agent/accounting";
import { keccak256 } from "viem";
import { hexToBytes } from "../db/index.js";
import type { Hex, RpcBlock, RpcReceipt, RpcTransaction } from "../rpc/types.js";

export class ParseError extends Error {
  override readonly name = "ParseError";
}

const hexInt = (h: string, what: string): number => {
  const v = hexQuantityToBigInt(h);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ParseError(`${what} exceeds safe integer: ${h}`);
  return Number(v);
};
const hexNum = (h: string): string => toSqlNumeric(hexQuantityToBigInt(h));
const bytes = (h: string): Buffer => hexToBytes(h);
const optBytes = (h: string | null | undefined): Buffer | null => (h ? hexToBytes(h) : null);
const optNum = (h: string | null | undefined): string | null => (h ? hexNum(h) : null);

/**
 * Arc encodes the NEXT block's base fee in the header's extraData as an 8-byte big-endian integer
 * (docs.arc.io/arc/references/gas-and-fees, 2026-09-14). Observed on testnet: 0x00000004a817c800 = 20 gwei.
 * Genesis and early blocks carry empty extraData. Anything that is not exactly 8 bytes -> null.
 */
export function nextBaseFeeFromExtraData(extraData: string): bigint | null {
  if (typeof extraData !== "string" || !/^0x[0-9a-fA-F]*$/.test(extraData)) return null;
  const hex = extraData.slice(2);
  if (hex.length !== 16) return null;
  return BigInt("0x" + hex);
}

export interface ParsedBlock {
  number: number;
  hash: Buffer;
  parentHash: Buffer;
  timestamp: number;
  miner: Buffer;
  gasLimit: number;
  gasUsed: number;
  gasUsedRatio: number;
  baseFeePerGas: string;
  nextBaseFeePerGas: string | null;
  extraData: Buffer;
  txCount: number;
  sizeBytes: number | null;
  stateRoot: Buffer;
  receiptsRoot: Buffer;
  transactionsRoot: Buffer;
  raw: Record<string, unknown>; // header without transactions
}

export interface ParsedTx {
  blockNumber: number;
  txIndex: number;
  hash: Buffer;
  from: Buffer;
  to: Buffer | null;
  value: string;
  nonce: number;
  gas: number;
  gasPrice: string | null;
  maxFeePerGas: string | null;
  maxPriorityFeePerGas: string | null;
  txType: number;
  chainId: number | null;
  inputSelector: Buffer | null;
  inputSize: number;
  input: Buffer;
  raw: RpcTransaction | Omit<RpcTransaction, "input">;
}

export interface ParsedReceipt {
  txHash: Buffer;
  blockNumber: number;
  txIndex: number;
  status: number;
  gasUsed: number;
  cumulativeGasUsed: number;
  effectiveGasPrice: string;
  feeUsdc18: string;
  contractAddress: Buffer | null;
  logsCount: number;
  raw: RpcReceipt | Omit<RpcReceipt, "logs">;
}

export interface ParsedLog {
  blockNumber: number;
  logIndex: number;
  txIndex: number;
  txHash: Buffer;
  address: Buffer;
  topics: [Buffer | null, Buffer | null, Buffer | null, Buffer | null];
  data: Buffer;
}

export interface ParsedDeploy {
  address: Buffer;
  deployer: Buffer;
  txHash: Buffer;
  blockNumber: number;
  txIndex: number;
  blockTimestamp: number;
  initCodeSize: number;
  initCodeHash: Buffer;
  success: boolean;
}

export type OpClass = "native_transfer" | "erc20_transfer" | "contract_call" | "deploy";

export interface BlockStats {
  blockNumber: number;
  timestamp: number;
  txCount: number;
  failed: number;
  counts: Record<OpClass, number>;
  fees: Record<OpClass, bigint>;
  feeTotal: bigint;
  gasUsed: number;
}

const ERC20_TRANSFER = "a9059cbb";

/** Pure classification used by both the stats and the API: deploy > native transfer > ERC-20 transfer > call. */
export function classifyTx(tx: Pick<ParsedTx, "to" | "inputSize" | "inputSelector">): OpClass {
  if (tx.to === null) return "deploy";
  if (tx.inputSize === 0) return "native_transfer";
  if (tx.inputSelector && tx.inputSelector.toString("hex") === ERC20_TRANSFER) return "erc20_transfer";
  return "contract_call";
}

export function computeStats(block: ParsedBlock, txs: readonly ParsedTx[], receipts: readonly ParsedReceipt[]): BlockStats {
  const counts: Record<OpClass, number> = { native_transfer: 0, erc20_transfer: 0, contract_call: 0, deploy: 0 };
  const fees: Record<OpClass, bigint> = { native_transfer: 0n, erc20_transfer: 0n, contract_call: 0n, deploy: 0n };
  let failed = 0;
  let feeTotal = 0n;
  for (let i = 0; i < txs.length; i++) {
    const cls = classifyTx(txs[i]!);
    const fee = BigInt(receipts[i]!.feeUsdc18);
    counts[cls]++;
    fees[cls] += fee;
    feeTotal += fee;
    if (receipts[i]!.status !== 1) failed++;
  }
  return { blockNumber: block.number, timestamp: block.timestamp, txCount: txs.length, failed, counts, fees, feeTotal, gasUsed: block.gasUsed };
}

export interface ParsedBlockBundle {
  block: ParsedBlock;
  stats: BlockStats;
  txs: ParsedTx[];
  receipts: ParsedReceipt[];
  logs: ParsedLog[];
  deploys: ParsedDeploy[];
  failedTxHashes: Buffer[];
}

export function parseBlockHeader(b: RpcBlock): ParsedBlock {
  const number = hexInt(b.number, "block.number");
  const gasLimit = hexInt(b.gasLimit, "block.gasLimit");
  const gasUsed = hexInt(b.gasUsed, "block.gasUsed");
  if (!b.baseFeePerGas) throw new ParseError(`block ${number} has no baseFeePerGas`);
  const { transactions: _txs, ...header } = b;
  const nb = nextBaseFeeFromExtraData(b.extraData);
  return {
    number,
    hash: bytes(b.hash),
    parentHash: bytes(b.parentHash),
    timestamp: hexInt(b.timestamp, "block.timestamp"),
    miner: bytes(b.miner),
    gasLimit,
    gasUsed,
    gasUsedRatio: gasLimit === 0 ? 0 : gasUsed / gasLimit,
    baseFeePerGas: hexNum(b.baseFeePerGas),
    nextBaseFeePerGas: nb === null ? null : toSqlNumeric(nb),
    extraData: bytes(b.extraData),
    txCount: Array.isArray(b.transactions) ? b.transactions.length : 0,
    sizeBytes: b.size ? hexInt(b.size, "block.size") : null,
    stateRoot: bytes(b.stateRoot),
    receiptsRoot: bytes(b.receiptsRoot),
    transactionsRoot: bytes(b.transactionsRoot),
    raw: header,
  };
}

export type RawMode = "full" | "compact";

export function parseTx(t: RpcTransaction, blockNumber: number, rawMode: RawMode = "compact"): ParsedTx {
  const input = t.input ?? "0x";
  const inputBytes = (input.length - 2) / 2;
  const { input: _dropped, ...rawNoInput } = t;
  return {
    blockNumber,
    txIndex: hexInt(t.transactionIndex, "tx.transactionIndex"),
    hash: bytes(t.hash),
    from: bytes(t.from),
    to: optBytes(t.to),
    value: hexNum(t.value),
    nonce: hexInt(t.nonce, "tx.nonce"),
    gas: hexInt(t.gas, "tx.gas"),
    gasPrice: optNum(t.gasPrice),
    maxFeePerGas: optNum(t.maxFeePerGas),
    maxPriorityFeePerGas: optNum(t.maxPriorityFeePerGas),
    txType: hexInt(t.type ?? "0x0", "tx.type"),
    chainId: t.chainId ? hexInt(t.chainId, "tx.chainId") : null,
    inputSelector: inputBytes >= 4 ? Buffer.from(input.slice(2, 10), "hex") : null,
    inputSize: inputBytes,
    input: bytes(input),
    raw: rawMode === "full" ? t : rawNoInput,
  };
}

export function parseReceipt(r: RpcReceipt, blockNumber: number, rawMode: RawMode = "compact"): ParsedReceipt {
  const gasUsed = hexQuantityToBigInt(r.gasUsed);
  const price = hexQuantityToBigInt(r.effectiveGasPrice);
  const { logs: _dropped, ...rawNoLogs } = r;
  return {
    txHash: bytes(r.transactionHash),
    blockNumber,
    txIndex: hexInt(r.transactionIndex, "receipt.transactionIndex"),
    status: hexInt(r.status, "receipt.status"),
    gasUsed: Number(gasUsed),
    cumulativeGasUsed: hexInt(r.cumulativeGasUsed, "receipt.cumulativeGasUsed"),
    effectiveGasPrice: toSqlNumeric(price),
    feeUsdc18: toSqlNumeric(txFee18(gasUsed, price)),
    contractAddress: optBytes(r.contractAddress),
    logsCount: r.logs.length,
    raw: rawMode === "full" ? r : rawNoLogs,
  };
}

export function parseLogs(r: RpcReceipt, blockNumber: number, txIndex: number): ParsedLog[] {
  return r.logs.map((l) => ({
    blockNumber,
    logIndex: hexInt(l.logIndex, "log.logIndex"),
    txIndex,
    txHash: bytes(l.transactionHash),
    address: bytes(l.address),
    topics: [optBytes(l.topics[0]), optBytes(l.topics[1]), optBytes(l.topics[2]), optBytes(l.topics[3])],
    data: bytes(l.data),
  }));
}

/**
 * Validates that receipts belong to the block and match its transactions 1:1, then parses everything.
 * Throws ParseError on inconsistency (caller treats it as a transient RPC problem and refetches).
 */
export function parseBundle(rawBlock: RpcBlock, rawReceipts: RpcReceipt[], rawMode: RawMode = "compact"): ParsedBlockBundle {
  const block = parseBlockHeader(rawBlock);
  const txsRaw = rawBlock.transactions;
  if (txsRaw.length > 0 && typeof txsRaw[0] === "string") throw new ParseError(`block ${block.number}: transactions are hashes, need full objects`);
  const txObjs = txsRaw as RpcTransaction[];
  if (rawReceipts.length !== txObjs.length) throw new ParseError(`block ${block.number}: ${txObjs.length} txs but ${rawReceipts.length} receipts`);
  const txs: ParsedTx[] = [];
  const receipts: ParsedReceipt[] = [];
  const logs: ParsedLog[] = [];
  const deploys: ParsedDeploy[] = [];
  const failedTxHashes: Buffer[] = [];
  for (let i = 0; i < txObjs.length; i++) {
    const t = txObjs[i]!;
    const r = rawReceipts[i]!;
    if (t.blockHash.toLowerCase() !== rawBlock.hash.toLowerCase()) throw new ParseError(`block ${block.number}: tx ${t.hash} has blockHash ${t.blockHash}`);
    if (r.transactionHash.toLowerCase() !== t.hash.toLowerCase()) throw new ParseError(`block ${block.number}: receipt[${i}] is for ${r.transactionHash}, tx is ${t.hash}`);
    if (r.blockHash.toLowerCase() !== rawBlock.hash.toLowerCase()) throw new ParseError(`block ${block.number}: receipt ${r.transactionHash} has blockHash ${r.blockHash}`);
    const pt = parseTx(t, block.number, rawMode);
    if (pt.txIndex !== i) throw new ParseError(`block ${block.number}: tx index ${pt.txIndex} at position ${i}`);
    const pr = parseReceipt(r, block.number, rawMode);
    txs.push(pt);
    receipts.push(pr);
    logs.push(...parseLogs(r, block.number, i));
    if (pt.to === null) {
      const initCode = (t.input ?? "0x") as Hex;
      deploys.push({
        address: pr.contractAddress ?? deriveCreateAddressFallback(t),
        deployer: pt.from,
        txHash: pt.hash,
        blockNumber: block.number,
        txIndex: i,
        blockTimestamp: block.timestamp,
        initCodeSize: pt.inputSize,
        initCodeHash: bytes(keccak256(initCode)),
        success: pr.status === 1,
      });
    }
    if (pr.status !== 1) failedTxHashes.push(pt.hash);
  }
  return { block, stats: computeStats(block, txs, receipts), txs, receipts, logs, deploys, failedTxHashes };
}

/** Failed creations may have contractAddress=null; use the deterministic CREATE address for the row key. */
function deriveCreateAddressFallback(t: RpcTransaction): Buffer {
  // keccak256(rlp([sender, nonce]))[12:]
  const sender = hexToBytes(t.from);
  const nonce = hexQuantityToBigInt(t.nonce);
  const nonceBytes = nonce === 0n ? Buffer.alloc(0) : Buffer.from(nonce.toString(16).padStart(Math.ceil(nonce.toString(16).length / 2) * 2, "0"), "hex");
  const rlpItem = (b: Buffer): Buffer => (b.length === 1 && b[0]! < 0x80 ? b : Buffer.concat([Buffer.from([0x80 + b.length]), b]));
  const payload = Buffer.concat([rlpItem(sender), nonce === 0n ? Buffer.from([0x80]) : rlpItem(nonceBytes)]);
  const list = Buffer.concat([Buffer.from([0xc0 + payload.length]), payload]);
  return hexToBytes(keccak256(`0x${list.toString("hex")}`)).subarray(12);
}
