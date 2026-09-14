/** Raw JSON-RPC shapes as returned by Arc nodes. Kept as strings/hex on purpose (raw storage). */
export type Hex = `0x${string}`;

export interface RpcBlock {
  hash: Hex;
  parentHash: Hex;
  number: Hex;
  timestamp: Hex;
  miner: Hex;
  gasLimit: Hex;
  gasUsed: Hex;
  baseFeePerGas?: Hex;
  extraData: Hex;
  size?: Hex;
  stateRoot: Hex;
  receiptsRoot: Hex;
  transactionsRoot: Hex;
  transactions: RpcTransaction[] | Hex[];
  [k: string]: unknown;
}

export interface RpcTransaction {
  hash: Hex;
  blockHash: Hex;
  blockNumber: Hex;
  transactionIndex: Hex;
  from: Hex;
  to: Hex | null;
  value: Hex;
  nonce: Hex;
  gas: Hex;
  gasPrice?: Hex;
  maxFeePerGas?: Hex;
  maxPriorityFeePerGas?: Hex;
  type: Hex;
  chainId?: Hex;
  input: Hex;
  [k: string]: unknown;
}

export interface RpcLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  transactionIndex: Hex;
  logIndex: Hex;
  removed?: boolean;
  [k: string]: unknown;
}

export interface RpcReceipt {
  transactionHash: Hex;
  transactionIndex: Hex;
  blockHash: Hex;
  blockNumber: Hex;
  status: Hex;
  gasUsed: Hex;
  cumulativeGasUsed: Hex;
  effectiveGasPrice: Hex;
  contractAddress: Hex | null;
  logs: RpcLog[];
  from: Hex;
  to: Hex | null;
  type: Hex;
  [k: string]: unknown;
}

export interface JsonRpcCall {
  method: string;
  params: unknown[];
}

export interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}
