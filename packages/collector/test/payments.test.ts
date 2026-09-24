import { describe, expect, it } from "vitest";
import { TRANSFER_TOPIC } from "../src/ingest/fx.js";
import { parseBundle } from "../src/ingest/parse.js";
import { AUTHORIZATION_USED_TOPIC, pairAuthorizations, type StoredLog } from "../src/ingest/payments.js";
import type { Hex, RpcBlock, RpcLog, RpcReceipt, RpcTransaction } from "../src/rpc/types.js";
import { nextFill, paymentsFromReceipts } from "../src/workers/payments.js";

const hex = (h: string): Buffer => Buffer.from(h.replace(/^0x/, ""), "hex");
const word = (addrOrNumber: string | bigint): Buffer => hex(typeof addrOrNumber === "bigint" ? addrOrNumber.toString(16).padStart(64, "0") : addrOrNumber.replace(/^0x/, "").padStart(64, "0"));
const USDC = hex("0x3600000000000000000000000000000000000000");
const NATIVE_LEDGER = hex("0xfffffffffffffffffffffffffffffffffffffffe");
const TX = hex("0x9dc571fea973599c4c9b5b89862789feb38eb9342401c4b4b9e81d1c5008643a");
const PAYER = "0x1f09b3101bfe055eb746a7778a77973a52fa11ed";
const PAYEE = "0x5bfa14840e694d4942e451f870b3f25ddd25b65d";
const NONCE = "0x87deb8e4d2d95e6bf098a9864a08b79fd7390aafe47f1eb991dc8d4732e16d9d";

const log = (logIndex: number, over: Partial<StoredLog>): StoredLog => ({ blockNumber: 22415159, logIndex, txIndex: 1, txHash: TX, address: USDC, topic0: null, topic1: null, topic2: null, data: Buffer.alloc(0), ...over });
const auth = (logIndex: number, payer = PAYER, nonce = NONCE, over: Partial<StoredLog> = {}) => log(logIndex, { topic0: hex(AUTHORIZATION_USED_TOPIC), topic1: word(payer), topic2: hex(nonce), ...over });
const transfer = (logIndex: number, from: string, to: string, amount: bigint, over: Partial<StoredLog> = {}) => log(logIndex, { topic0: hex(TRANSFER_TOPIC), topic1: word(from), topic2: word(to), data: word(amount), ...over });

describe("payments by signed authorization, read from a transaction's logs", () => {
  it("reads a real x402 payment on Arc: payer, payee and amount from the token's own transfer, not the native ledger's", () => {
    // Block 22415159, tx 0x9dc5…643a: AuthorizationUsed, the native ledger's 18-decimal mirror, then USDC's Transfer.
    const logs = [auth(0), transfer(1, PAYER, PAYEE, 0x5987443857000n, { address: NATIVE_LEDGER }), transfer(2, PAYER, PAYEE, 0x627n)];
    const [p, ...rest] = pairAuthorizations(logs);
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ blockNumber: 22415159, logIndex: 0, txIndex: 1, amount: 1575n });
    expect(`0x${p!.payer.toString("hex")}`).toBe(PAYER);
    expect(`0x${p!.payee.toString("hex")}`).toBe(PAYEE);
    expect(`0x${p!.token.toString("hex")}`).toBe("0x3600000000000000000000000000000000000000");
    expect(`0x${p!.nonce.toString("hex")}`).toBe(NONCE);
  });

  it("gives each authorization of a batch its own transfer", () => {
    const other = "0x00000000000000000000000000000000000000aa";
    const logs = [auth(0), transfer(1, PAYER, PAYEE, 10n), auth(2, PAYER, `0x${"11".repeat(32)}`), transfer(3, PAYER, other, 20n), auth(4, other, `0x${"22".repeat(32)}`), transfer(5, other, PAYEE, 30n)];
    const paid = pairAuthorizations(logs.reverse());
    expect(paid.map((p) => [p.logIndex, p.amount, `0x${p.payee.toString("hex")}`])).toEqual([
      [0, 10n, PAYEE],
      [2, 20n, other],
      [4, 30n, PAYEE],
    ]);
  });

  it("takes nothing it cannot pair: no transfer after it, a transfer from someone else, or from another contract", () => {
    expect(pairAuthorizations([transfer(0, PAYER, PAYEE, 5n), auth(1)])).toEqual([]);
    expect(pairAuthorizations([auth(0), transfer(1, "0x00000000000000000000000000000000000000bb", PAYEE, 5n)])).toEqual([]);
    expect(pairAuthorizations([auth(0), transfer(1, PAYER, PAYEE, 5n, { address: hex("0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1") })])).toEqual([]);
    expect(pairAuthorizations([auth(0), transfer(1, PAYER, PAYEE, 5n, { data: Buffer.alloc(0) })])).toEqual([]);
    // Two transactions in the same block do not borrow from each other.
    expect(pairAuthorizations([auth(0), transfer(1, PAYER, PAYEE, 5n, { txIndex: 2 })])).toEqual([]);
  });

  it("works for any EIP-3009 token, and keeps which one it was", () => {
    const EURC = hex("0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1");
    const [p] = pairAuthorizations([auth(0, PAYER, NONCE, { address: EURC }), transfer(1, PAYER, PAYEE, 990000n, { address: EURC })]);
    expect(p!.token.equals(EURC)).toBe(true);
    expect(p!.amount).toBe(990000n);
  });
});

// The same payment as the chain returns it: block 22415159, the second transaction, submitted by 0x2b9a….
const hx = (s: string): Hex => s as Hex;
const BLOCK_HASH = hx(`0x${"ab".repeat(32)}`);
const RELAYER = "0x2b9a3197ed35d56e2e1c2a01f4d649586821055c";
const pad = (a: string) => hx(`0x${a.replace(/^0x/, "").padStart(64, "0")}`);
const rpcLog = (i: number, address: string, topics: string[], data: string, txIndex = 1): RpcLog => ({
  address: hx(address),
  topics: topics.map(hx),
  data: hx(data),
  blockHash: BLOCK_HASH,
  blockNumber: hx("0x1560737"),
  blockTimestamp: "0x6ab44c77",
  transactionHash: hx(`0x${TX.toString("hex")}`),
  transactionIndex: hx(`0x${txIndex.toString(16)}`),
  logIndex: hx(`0x${i.toString(16)}`),
  removed: false,
});
const realLogs = (): RpcLog[] => [
  rpcLog(0, "0x3600000000000000000000000000000000000000", [AUTHORIZATION_USED_TOPIC, pad(PAYER), NONCE], "0x"),
  rpcLog(1, "0xfffffffffffffffffffffffffffffffffffffffe", [TRANSFER_TOPIC, pad(PAYER), pad(PAYEE)], pad("5987443857000")),
  rpcLog(2, "0x3600000000000000000000000000000000000000", [TRANSFER_TOPIC, pad(PAYER), pad(PAYEE)], pad("627")),
];
const rpcReceipt = (over: Partial<RpcReceipt> = {}): RpcReceipt => ({
  type: "0x2",
  status: "0x1",
  cumulativeGasUsed: "0x1",
  gasUsed: "0x1",
  effectiveGasPrice: "0x1",
  logs: realLogs(),
  transactionHash: hx(`0x${TX.toString("hex")}`),
  transactionIndex: "0x1",
  blockHash: BLOCK_HASH,
  blockNumber: "0x1560737",
  from: hx(RELAYER),
  to: "0x3600000000000000000000000000000000000000",
  contractAddress: null,
  ...over,
});

describe("where payments are found", () => {
  it("in a block the collector parses, in light mode as much as in full: the relayer is the transaction's sender", () => {
    const other: RpcTransaction = { type: "0x2", chainId: "0x13b2", nonce: "0x1", gas: "0x5208", to: hx("0x00000000000000000000000000000000000000cc"), value: "0x1", input: "0x", hash: hx(`0x${"22".repeat(32)}`), blockHash: BLOCK_HASH, blockNumber: "0x1560737", transactionIndex: "0x0", from: hx("0x00000000000000000000000000000000000000dd") };
    const paying: RpcTransaction = { ...other, nonce: "0x2", to: "0x3600000000000000000000000000000000000000", value: "0x0", input: hx(`0xe3ee160e${"00".repeat(32)}`), hash: hx(`0x${TX.toString("hex")}`), transactionIndex: "0x1", from: hx(RELAYER) };
    const block: RpcBlock = {
      hash: BLOCK_HASH, parentHash: hx(`0x${"cd".repeat(32)}`), number: "0x1560737", timestamp: "0x6ab44c77", miner: "0x8214f788885a40fc2018c15a5e00bccb9a875ef2",
      gasLimit: "0x1c9c380", gasUsed: "0x2", baseFeePerGas: "0x1", extraData: "0x", size: "0x100",
      stateRoot: hx(`0x${"01".repeat(32)}`), receiptsRoot: hx(`0x${"02".repeat(32)}`), transactionsRoot: hx(`0x${"03".repeat(32)}`), difficulty: "0x0",
      transactions: [other, paying],
    };
    const plain = rpcReceipt({ transactionHash: other.hash, transactionIndex: "0x0", from: other.from, to: other.to, logs: [] });
    const bundle = parseBundle(block, [plain, rpcReceipt()]);
    expect(bundle.directPayments).toHaveLength(1);
    const [p] = bundle.directPayments;
    expect(p).toMatchObject({ blockNumber: 22415159, logIndex: 0, txIndex: 1, amount: 1575n, timestamp: 0x6ab44c77 });
    expect(`0x${p!.relayer.toString("hex")}`).toBe(RELAYER);
    expect(`0x${p!.called!.toString("hex")}`).toBe("0x3600000000000000000000000000000000000000");
    expect(parseBundle({ ...block, transactions: [other] }, [plain]).directPayments).toEqual([]);
  });

  it("in receipts fetched on their own, for blocks read before extraction existed", () => {
    const [p, ...rest] = paymentsFromReceipts([rpcReceipt(), rpcReceipt({ status: "0x0", transactionHash: hx(`0x${"33".repeat(32)}`) })]);
    expect(rest).toEqual([]);
    expect(p).toMatchObject({ blockNumber: 22415159, txIndex: 1, amount: 1575n, timestamp: 0x6ab44c77 });
    expect(`0x${p!.payee.toString("hex")}`).toBe(PAYEE);
    expect(`0x${p!.relayer.toString("hex")}`).toBe(RELAYER);
    // Without the block's time it cannot be dated, and says so rather than guessing.
    expect(() => paymentsFromReceipts([rpcReceipt({ logs: realLogs().map(({ blockTimestamp: _t, ...l }) => l as RpcLog) })])).toThrow(/blockTimestamp/);
  });
});

describe("what the one-time fill covers", () => {
  it("first run: from the lowest block collected, or PAYMENTS_START_BLOCK, up to where extraction begins", () => {
    expect(nextFill(null, 0, 20_720_174, 22_430_000)).toEqual({ from: 20_720_174, until: 22_430_001, cursor: 20_720_174 });
    expect(nextFill(null, 1, 20_720_174, 22_430_000)).toEqual({ from: 1, until: 22_430_001, cursor: 1 });
    // A collector with nothing in it yet has nothing to fill.
    expect(nextFill(null, 0, null, 99)).toEqual({ from: 100, until: 100, cursor: 100 });
  });

  it("goes on with a fill that is not done, whatever the setting says now", () => {
    const halfway = { from: 20_720_174, until: 22_430_001, cursor: 21_000_000 };
    expect(nextFill(halfway, 1, 20_720_174, 22_500_000)).toBe(halfway);
  });

  it("after a finished fill, goes further back only when asked to", () => {
    const done = { from: 20_720_174, until: 22_430_001, cursor: 22_430_001 };
    expect(nextFill(done, 0, 20_720_174, 22_500_000)).toBe(done);
    expect(nextFill(done, 20_720_174, 20_720_174, 22_500_000)).toBe(done);
    expect(nextFill(done, 1, 20_720_174, 22_500_000)).toEqual({ from: 1, until: 20_720_174, cursor: 1 });
  });
});
