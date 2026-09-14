import { describe, expect, it } from "vitest";
import { nextBaseFeeFromExtraData, parseBlockHeader, parseBundle, ParseError } from "../src/ingest/parse.js";
import type { Hex, RpcBlock, RpcReceipt, RpcTransaction } from "../src/rpc/types.js";

const hx = (s: string): Hex => s as Hex;

// Shapes observed on Arc testnet (chain 5042002) on 2026-09-14.
const H = hx("0x" + "ab".repeat(32));
const tx = (over: Partial<RpcTransaction> = {}): RpcTransaction => ({
  type: "0x2",
  chainId: "0x4cef52",
  nonce: "0x20c",
  maxFeePerGas: "0x13122641ac",
  maxPriorityFeePerGas: "0x1",
  gas: "0x1b7740",
  to: "0x3600000000000000000000000000000000000000",
  value: "0x0",
  input: hx("0xa9059cbb" + "00".repeat(64)),
  hash: hx("0x" + "11".repeat(32)),
  blockHash: H,
  blockNumber: "0x3b34b58",
  transactionIndex: "0x0",
  from: "0x1c712af543789f3673c7cd4b9ffed00c29efaec1",
  ...over,
});
const receipt = (over: Partial<RpcReceipt> = {}): RpcReceipt => ({
  type: "0x2",
  status: "0x1",
  cumulativeGasUsed: "0xcd2fc",
  gasUsed: "0xcd2fc",
  effectiveGasPrice: "0x13122641ac",
  logs: [
    {
      address: "0xfffffffffffffffffffffffffffffffffffffffe",
      topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", hx("0x" + "00".repeat(12) + "b67edc20dc99fd15230af24ead0daca58aaa0038")],
      data: "0x00000000000000000000000000000000000000000000000000005af3107a4000",
      blockHash: H,
      blockNumber: "0x3b34b58",
      transactionHash: hx("0x" + "11".repeat(32)),
      transactionIndex: "0x0",
      logIndex: "0x0",
      removed: false,
    },
  ],
  transactionHash: hx("0x" + "11".repeat(32)),
  transactionIndex: "0x0",
  blockHash: H,
  blockNumber: "0x3b34b58",
  from: "0x1c712af543789f3673c7cd4b9ffed00c29efaec1",
  to: "0x3600000000000000000000000000000000000000",
  contractAddress: null,
  ...over,
});
const block = (txs: RpcTransaction[], over: Partial<RpcBlock> = {}): RpcBlock => ({
  hash: H,
  parentHash: hx("0x" + "cd".repeat(32)),
  number: "0x3b34b58",
  timestamp: "0x6aa8086f",
  miner: "0x8214f788885a40fc2018c15a5e00bccb9a875ef2",
  gasLimit: "0x1c9c380",
  gasUsed: "0x44f6a0",
  baseFeePerGas: "0x4a817c800",
  extraData: "0x00000004a817c800",
  size: "0x401e",
  stateRoot: hx("0x" + "01".repeat(32)),
  receiptsRoot: hx("0x" + "02".repeat(32)),
  transactionsRoot: hx("0x" + "03".repeat(32)),
  difficulty: "0x0",
  transactions: txs,
  ...over,
});

describe("nextBaseFeeFromExtraData", () => {
  it("decodes the 8-byte big-endian next base fee (20 gwei observed on testnet)", () => {
    expect(nextBaseFeeFromExtraData("0x00000004a817c800")).toBe(20_000_000_000n);
  });
  it("returns null for genesis-style empty extraData and other lengths", () => {
    expect(nextBaseFeeFromExtraData("0x")).toBeNull();
    expect(nextBaseFeeFromExtraData("0x0001")).toBeNull();
    expect(nextBaseFeeFromExtraData("0x" + "00".repeat(32))).toBeNull();
    expect(nextBaseFeeFromExtraData("nope")).toBeNull();
  });
});

describe("parseBlockHeader", () => {
  it("parses fields, gas ratio and strips transactions from raw", () => {
    const b = parseBlockHeader(block([tx()]));
    expect(b.number).toBe(0x3b34b58);
    expect(b.gasLimit).toBe(30_000_000);
    expect(b.gasUsedRatio).toBeCloseTo(0x44f6a0 / 30_000_000, 6);
    expect(b.baseFeePerGas).toBe("20000000000");
    expect(b.nextBaseFeePerGas).toBe("20000000000");
    expect(b.txCount).toBe(1);
    expect(b.raw).not.toHaveProperty("transactions");
    expect(b.raw).toHaveProperty("difficulty");
  });
});

describe("parseBundle", () => {
  it("parses a consistent block/receipt pair including fee, selector, logs", () => {
    const out = parseBundle(block([tx()]), [receipt()]);
    expect(out.txs[0]!.inputSelector!.toString("hex")).toBe("a9059cbb");
    expect(out.txs[0]!.inputSize).toBe(68);
    expect(out.receipts[0]!.feeUsdc18).toBe((0xcd2fcn * 0x13122641acn).toString());
    expect(out.logs).toHaveLength(1);
    expect(out.logs[0]!.topics[0]!.toString("hex")).toBe("ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
    expect(out.logs[0]!.topics[2]).toBeNull();
    expect(out.deploys).toHaveLength(0);
    expect(out.failedTxHashes).toHaveLength(0);
  });

  it("records contract deploys and failed txs", () => {
    const deployTx = tx({ to: null, input: "0x6080604052", type: "0x0", gasPrice: "0x13122641ac" });
    const deployRc = receipt({ to: null, contractAddress: "0xb54e5c1a4e03fe98a896bbb264118d08fded97a0", status: "0x0", logs: [] });
    const out = parseBundle(block([deployTx]), [deployRc]);
    expect(out.deploys).toHaveLength(1);
    expect(out.deploys[0]!.address.toString("hex")).toBe("b54e5c1a4e03fe98a896bbb264118d08fded97a0");
    expect(out.deploys[0]!.success).toBe(false);
    expect(out.deploys[0]!.initCodeSize).toBe(5);
    expect(out.failedTxHashes).toHaveLength(1);
    expect(out.txs[0]!.to).toBeNull();
    expect(out.txs[0]!.inputSelector!.toString("hex")).toBe("60806040");
  });

  it("derives the CREATE address when a failed deploy has no contractAddress", () => {
    // Known vector: sender 0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0 nonce 0 -> 0xcd234a471b72ba2f1ccf0a70fcaba648a5eecd8d
    const deployTx = tx({ to: null, input: "0x00", from: "0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0", nonce: "0x0" });
    const deployRc = receipt({ to: null, contractAddress: null, status: "0x0", logs: [] });
    const out = parseBundle(block([deployTx]), [deployRc]);
    expect(out.deploys[0]!.address.toString("hex")).toBe("cd234a471b72ba2f1ccf0a70fcaba648a5eecd8d");
  });

  it("rejects receipts that do not match the block or the txs", () => {
    expect(() => parseBundle(block([tx()]), [])).toThrow(ParseError);
    expect(() => parseBundle(block([tx()]), [receipt({ transactionHash: hx("0x" + "22".repeat(32)) })])).toThrow(ParseError);
    expect(() => parseBundle(block([tx()]), [receipt({ blockHash: hx("0x" + "ee".repeat(32)) })])).toThrow(ParseError);
    expect(() => parseBundle(block(["0x" + "11".repeat(32)] as unknown as RpcTransaction[]), [receipt()])).toThrow(ParseError);
  });

  it("parses an empty block", () => {
    const out = parseBundle(block([], { gasUsed: "0x0", extraData: "0x" }), []);
    expect(out.block.txCount).toBe(0);
    expect(out.block.nextBaseFeePerGas).toBeNull();
    expect(out.block.gasUsedRatio).toBe(0);
  });
});
