/**
 * Payments by signed authorization (EIP-3009), read from the logs of a transaction.
 *
 * transferWithAuthorization and receiveWithAuthorization emit AuthorizationUsed(authorizer, nonce)
 * and then the Transfer they authorized, from the same token contract and from the authorizer. A
 * relayer can settle several in one transaction, so each authorization takes the first such Transfer
 * after it that no earlier authorization took. On Arc, USDC also mirrors every move on its native
 * ledger (0xfff…fffe, 18 decimals); that log comes from another address and is never taken.
 */
import { TRANSFER_TOPIC } from "./fx.js";
import type { ParsedLog } from "./parse.js";

export const AUTHORIZATION_USED_TOPIC = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";

/** A log as the logs table stores it. */
export interface StoredLog {
  blockNumber: number;
  logIndex: number;
  txIndex: number;
  txHash: Buffer;
  address: Buffer;
  topic0: Buffer | null;
  topic1: Buffer | null;
  topic2: Buffer | null;
  data: Buffer;
}

export interface AuthorizedTransfer {
  blockNumber: number;
  /** Of the AuthorizationUsed log. */
  logIndex: number;
  txIndex: number;
  txHash: Buffer;
  token: Buffer;
  payer: Buffer;
  payee: Buffer;
  amount: bigint;
  nonce: Buffer;
}

/** A payment as stored: the authorization, the transfer it moved, when, and who submitted it. */
export interface DirectPaymentRow extends AuthorizedTransfer {
  timestamp: number;
  /** tx.from: who submitted it and paid the gas, usually a facilitator. */
  relayer: Buffer;
  /** tx.to: the token itself, or a contract that settles several at once. */
  called: Buffer | null;
}

const AUTH = Buffer.from(AUTHORIZATION_USED_TOPIC.slice(2), "hex");
const TRANSFER = Buffer.from(TRANSFER_TOPIC.slice(2), "hex");

/** The address in an indexed topic: its last 20 bytes. */
const addressOf = (topic: Buffer): Buffer => topic.subarray(12);

export function pairAuthorizations(logs: readonly StoredLog[]): AuthorizedTransfer[] {
  const byTx = new Map<string, StoredLog[]>();
  for (const l of logs) {
    const key = `${l.blockNumber}:${l.txIndex}`;
    const list = byTx.get(key);
    if (list) list.push(l);
    else byTx.set(key, [l]);
  }
  const out: AuthorizedTransfer[] = [];
  for (const list of byTx.values()) {
    list.sort((a, b) => a.logIndex - b.logIndex);
    const taken = new Set<number>();
    for (const auth of list) {
      if (!auth.topic0?.equals(AUTH) || auth.topic1?.length !== 32 || auth.topic2?.length !== 32) continue;
      const transfer = list.find(
        (t) => t.logIndex > auth.logIndex && !taken.has(t.logIndex) && t.topic0?.equals(TRANSFER) === true && t.address.equals(auth.address) && t.topic1?.equals(auth.topic1!) === true && t.topic2?.length === 32 && t.data.length === 32,
      );
      if (!transfer) continue;
      taken.add(transfer.logIndex);
      out.push({
        blockNumber: auth.blockNumber,
        logIndex: auth.logIndex,
        txIndex: auth.txIndex,
        txHash: auth.txHash,
        token: auth.address,
        payer: addressOf(auth.topic1!),
        payee: addressOf(transfer.topic2!),
        amount: BigInt(`0x${transfer.data.toString("hex")}`),
        nonce: auth.topic2!,
      });
    }
  }
  return out.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

export const storedFromParsed = (l: ParsedLog): StoredLog => ({ blockNumber: l.blockNumber, logIndex: l.logIndex, txIndex: l.txIndex, txHash: l.txHash, address: l.address, topic0: l.topics[0], topic1: l.topics[1], topic2: l.topics[2], data: l.data });

/**
 * The direct payments of one block, from the logs and transactions the collector already parsed.
 * Most blocks have none, and only the transactions that used an authorization are looked at.
 */
export function directPaymentsInBlock(timestamp: number, txs: ReadonlyArray<{ from: Buffer; to: Buffer | null }>, logs: readonly ParsedLog[]): DirectPaymentRow[] {
  const withAuth = new Set(logs.filter((l) => l.topics[0]?.equals(AUTH)).map((l) => l.txIndex));
  if (withAuth.size === 0) return [];
  return pairAuthorizations(logs.filter((l) => withAuth.has(l.txIndex)).map(storedFromParsed)).flatMap((p) => {
    const t = txs[p.txIndex];
    return t ? [{ ...p, timestamp, relayer: t.from, called: t.to }] : [];
  });
}
