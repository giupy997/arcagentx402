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

describe("a token that taxes its transfers", () => {
  // 18 decimals, volatile, so the band is wide and the price is per whole token.
  const CRA = "0x70857041Fef0CED97F9e01E7Ccc21889AFe3F6F4";
  const CRA_RULES: PairRules = { symbol: "CRA", token: CRA, decimals: 18, minPrice: 1e-9, maxPrice: 1e6, minBaseUnits: 1000n * 10n ** 18n };
  const cra = (whole: number) => BigInt(Math.round(whole * 1e6)) * 10n ** 12n;

  it("nets a split USDC leg instead of pricing the fee on its own", () => {
    // Taken from Arc mainnet 0xc1c1faf8…3f13: the buyer's USDC arrives as a 1% fee transfer and
    // the rest. Pricing the fee transfer alone reported a rate a hundred times too low.
    const logs = [
      transfer(USDC, TRADER, POOL, 1_215_261n),
      transfer(USDC, TRADER, POOL, 120_310_949n),
      transfer(CRA, POOL, TRADER, cra(555_406.29)),
    ];
    const t = extractFxTrade(logs, CRA, USDC, CRA_RULES)!;
    expect(t.direction).toBe("buy");
    expect(t.usdcAmount).toBe(121_526_210n);
    expect(t.rate).toBeCloseTo(0.0002188, 7);
  });

  it("ignores a pair of addresses that sends both tokens the same way", () => {
    // A routing hop: the same address hands on USDC and the token together. Not a swap.
    const logs = [transfer(USDC, TRADER, POOL, 107_138_800n), transfer(CRA, TRADER, POOL, cra(389_158.3))];
    expect(extractFxTrade(logs, CRA, USDC, CRA_RULES)).toBeNull();
  });

  it("prices the largest leg when a route touches two pools", () => {
    const other = "0x6666666666666666666666666666666666666666";
    const logs = [
      transfer(CRA, TRADER, POOL, cra(10_000)),
      transfer(USDC, POOL, TRADER, 2_000_000n),
      transfer(CRA, TRADER, other, cra(100_000)),
      transfer(USDC, other, TRADER, 22_000_000n),
    ];
    const t = extractFxTrade(logs, CRA, USDC, CRA_RULES)!;
    expect(t.venue).toBe(other.toLowerCase());
    expect(t.usdcAmount).toBe(22_000_000n);
  });
});
