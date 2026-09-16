import { describe, expect, it } from "vitest";
import { extractFxTrade, TRANSFER_TOPIC, type PairRules } from "../src/ingest/fx.js";

const EURC = "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1";
const RULES: PairRules = { symbol: "EURC", token: EURC, decimals: 6, minPrice: 0.5, maxPrice: 2, minBaseUnits: 1_000_000n };
const USDC = "0x3600000000000000000000000000000000000000";
const pad = (a: string) => `0x${"0".repeat(24)}${a.replace(/^0x/, "").toLowerCase()}`;
const amount = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;
const transfer = (token: string, from: string, to: string, value: bigint) => ({ address: token, topics: [TRANSFER_TOPIC, pad(from), pad(to)], data: amount(value) });

const TRADER = "0x1111111111111111111111111111111111111111";
const POOL = "0x2222222222222222222222222222222222222222";

describe("extractFxTrade", () => {
  it("reads a EURC to USDC swap and its executed rate", () => {
    const t = extractFxTrade([transfer(EURC, TRADER, POOL, 1_000_000n), transfer(USDC, POOL, TRADER, 1_170_000n)], EURC, USDC, RULES);
    expect(t).toMatchObject({ direction: "sell", trader: TRADER.toLowerCase(), venue: POOL.toLowerCase(), baseAmount: 1_000_000n, usdcAmount: 1_170_000n });
    expect(t!.rate).toBeCloseTo(1.17, 6);
  });

  it("reads the other direction", () => {
    const t = extractFxTrade([transfer(USDC, TRADER, POOL, 2_340_000n), transfer(EURC, POOL, TRADER, 2_000_000n)], EURC, USDC, RULES);
    expect(t).toMatchObject({ direction: "buy", trader: TRADER.toLowerCase() });
    expect(t!.rate).toBeCloseTo(1.17, 6);
  });

  it("ignores transactions that are not two-sided swaps", () => {
    expect(extractFxTrade([transfer(EURC, TRADER, POOL, 1_000_000n)], EURC, USDC, RULES)).toBeNull();
    expect(extractFxTrade([transfer(USDC, TRADER, POOL, 1_000_000n)], EURC, USDC, RULES)).toBeNull();
    // both tokens move but between unrelated parties
    expect(extractFxTrade([transfer(EURC, TRADER, POOL, 1_000_000n), transfer(USDC, "0x3333333333333333333333333333333333333333", "0x4444444444444444444444444444444444444444", 1n)], EURC, USDC, RULES)).toBeNull();
  });

  it("ignores zero-value and dust legs", () => {
    expect(extractFxTrade([transfer(EURC, TRADER, POOL, 0n), transfer(USDC, POOL, TRADER, 1_000n)], EURC, USDC, RULES)).toBeNull();
    // 0.1 EURC: too small to price anything
    expect(extractFxTrade([transfer(EURC, TRADER, POOL, 100_000n), transfer(USDC, POOL, TRADER, 117_000n)], EURC, USDC, RULES)).toBeNull();
  });

  it("requires both legs to move between the same two addresses", () => {
    // EURC goes trader → pool, USDC goes pool → someone else: not a swap for this trader
    const other = "0x5555555555555555555555555555555555555555";
    expect(extractFxTrade([transfer(EURC, TRADER, POOL, 10_000_000n), transfer(USDC, POOL, other, 11_700_000n)], EURC, USDC, RULES)).toBeNull();
  });

  it("rejects rates outside the plausible EUR/USD band", () => {
    // a router that also moved unrelated USDC would otherwise produce a nonsense rate
    expect(extractFxTrade([transfer(EURC, TRADER, POOL, 10_000_000n), transfer(USDC, POOL, TRADER, 2n)], EURC, USDC, RULES)).toBeNull();
    expect(extractFxTrade([transfer(EURC, TRADER, POOL, 10_000_000n), transfer(USDC, POOL, TRADER, 900_000_000n)], EURC, USDC, RULES)).toBeNull();
  });
});

describe("ambiguous swaps", () => {
  it("uses log order when both directions look possible", () => {
    // trader → pool (USDC) logged first, then pool → trader (EURC): a USDC sale
    const usdcFirst = extractFxTrade([transfer(USDC, TRADER, POOL, 2_340_000n), transfer(EURC, POOL, TRADER, 2_000_000n)], EURC, USDC, RULES);
    expect(usdcFirst!.direction).toBe("buy");
    expect(usdcFirst!.trader).toBe(TRADER.toLowerCase());
    // the same two legs in the opposite order read as a EURC sale
    const eurcFirst = extractFxTrade([transfer(EURC, TRADER, POOL, 2_000_000n), transfer(USDC, POOL, TRADER, 2_340_000n)], EURC, USDC, RULES);
    expect(eurcFirst!.direction).toBe("sell");
    expect(eurcFirst!.trader).toBe(TRADER.toLowerCase());
  });
});
