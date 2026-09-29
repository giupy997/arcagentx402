import { describe, expect, it } from "vitest";
import { depositAmount, parseFundArgs } from "../src/fund.js";

describe("cra-agent fund", () => {
  it("reads what to move, from where, and what to do with it on Arc", () => {
    expect(parseFundArgs(["5", "--from", "base"])).toEqual({ amount: 5_000_000n, from: "base", deposit: true, keep: 10_000n, dryRun: false });
    expect(parseFundArgs(["2.5", "--from", "solana", "--solana-key-file", "/k", "--max-fee", "0.02", "--keep", "0.05", "--no-deposit", "--dry-run"])).toEqual({ amount: 2_500_000n, from: "solana", solanaKeyFile: "/k", maxFee: 20_000n, deposit: false, keep: 50_000n, dryRun: true });
    expect(parseFundArgs(["--from", "base", "1"]).amount).toBe(1_000_000n);
  });

  it("refuses what it cannot do safely", () => {
    expect(() => parseFundArgs(["5"])).toThrow(/--from base or --from solana/);
    expect(() => parseFundArgs(["5", "--from", "ethereum"])).toThrow(/--from base or --from solana/);
    expect(() => parseFundArgs(["--from", "base"])).toThrow(/the amount is USDC/);
    expect(() => parseFundArgs(["0", "--from", "base"])).toThrow(/the amount is USDC/);
    expect(() => parseFundArgs(["all", "--from", "base"])).toThrow(/the amount is USDC/);
    expect(() => parseFundArgs(["5", "--from", "solana"])).toThrow(/--solana-key-file/);
    expect(() => parseFundArgs(["5", "--from", "base", "--max-fee", "1%"])).toThrow(/--max-fee is an amount/);
    expect(() => parseFundArgs(["5", "--from"])).toThrow(/--from needs a value/);
  });

  it("deposits what arrived, never the last cent the wallet needs for Arc's gas", () => {
    expect(depositAmount(4_999_000n, 5_200_000n, 10_000n)).toBe(4_999_000n);
    expect(depositAmount(4_999_000n, 5_000_000n, 10_000n)).toBe(4_990_000n);
    expect(depositAmount(4_999_000n, 5_000n, 10_000n)).toBe(0n);
  });
});
