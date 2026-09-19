import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  AccountingError,
  SCALE_6_TO_18,
  addUsdc6,
  compareMixed,
  formatUsdc18,
  formatUsdc6,
  gweiToUsdc18,
  hexQuantityToBigInt,
  parseUsdc18,
  parseUsdc6,
  splitUsdc18,
  toUsdc18,
  toUsdc6Exact,
  toUsdc6Floor,
  toUsdc6Rounded,
  txFee18,
  txFee18FromReceipt,
  usdc18,
  usdc6,
} from "../src/index.js";

const MAX_UINT256 = (1n << 256n) - 1n;
const arbBig = (max: bigint) => fc.bigInt({ min: -max, max });

describe("6 <-> 18 decimal conversions", () => {
  it("6 -> 18 -> 6 is the identity for any Usdc6", () => {
    fc.assert(
      fc.property(arbBig(MAX_UINT256 / SCALE_6_TO_18), (raw) => {
        const a = usdc6(raw);
        expect(toUsdc6Exact(toUsdc18(a))).toBe(a);
        expect(toUsdc6Floor(toUsdc18(a))).toBe(a);
        expect(toUsdc6Rounded(toUsdc18(a))).toBe(a);
      }),
    );
  });

  it("split never loses value: to18(usdc6) + dust18 === original", () => {
    fc.assert(
      fc.property(arbBig(MAX_UINT256), (raw) => {
        const a = usdc18(raw);
        const { usdc6: q, dust18 } = splitUsdc18(a);
        expect(toUsdc18(q) + dust18).toBe(a);
        expect(dust18 < SCALE_6_TO_18 && dust18 > -SCALE_6_TO_18).toBe(true);
        // dust has the sign of the input (or is zero)
        if (dust18 !== 0n) expect(dust18 < 0n).toBe(raw < 0n);
      }),
    );
  });

  it("toUsdc6Exact throws exactly when there is dust", () => {
    fc.assert(
      fc.property(arbBig(MAX_UINT256), (raw) => {
        const a = usdc18(raw);
        const hasDust = raw % SCALE_6_TO_18 !== 0n;
        if (hasDust) expect(() => toUsdc6Exact(a)).toThrow(AccountingError);
        else expect(toUsdc6Exact(a)).toBe(raw / SCALE_6_TO_18);
      }),
    );
  });

  it("rounded is within 1 micro of floor and picks the nearer", () => {
    fc.assert(
      fc.property(arbBig(MAX_UINT256), (raw) => {
        const a = usdc18(raw);
        const fl = toUsdc6Floor(a);
        const ro = toUsdc6Rounded(a);
        const diff = ro - fl;
        expect(diff === 0n || diff === 1n || diff === -1n).toBe(true);
        const errFloor = raw - toUsdc18(fl);
        const errRound = raw - toUsdc18(ro);
        const abs = (x: bigint) => (x < 0n ? -x : x);
        expect(abs(errRound) <= abs(errFloor)).toBe(true);
      }),
    );
  });

  it("known values from the docs: ERC-20 balanceOf truncates, native keeps dust", () => {
    // 1.5000005 USDC held natively -> ERC-20 shows 1.500000, dust 500000000000 (18-dec units)
    const native = parseUsdc18("1.5000005");
    const { usdc6: shown, dust18 } = splitUsdc18(native);
    expect(formatUsdc6(shown)).toBe("1.5");
    expect(dust18).toBe(500_000_000_000n);
    // zero balanceOf != zero native balance
    const tiny = usdc18(999_999_999_999n);
    expect(toUsdc6Floor(tiny)).toBe(0n);
    expect(tiny).not.toBe(0n);
  });

  it("compareMixed compares exactly across representations", () => {
    expect(compareMixed(parseUsdc6("1"), parseUsdc18("1"))).toBe(0);
    expect(compareMixed(parseUsdc6("1"), parseUsdc18("1.000000000000000001"))).toBe(-1);
    expect(compareMixed(parseUsdc6("1.000001"), parseUsdc18("1.0000009"))).toBe(1);
  });
});

describe("parse / format round-trips (no floats)", () => {
  const arbDecimal = (maxFrac: number) =>
    fc
      .tuple(
        fc.boolean(),
        fc.bigInt({ min: 0n, max: 10n ** 30n }),
        fc.string({ unit: fc.constantFrom(..."0123456789"), minLength: 0, maxLength: maxFrac }),
      )
      .map(([neg, i, f]) => `${neg ? "-" : ""}${i}${f.length ? "." + f : ""}`);

  it("parseUsdc6 -> formatUsdc6 -> parseUsdc6 is stable", () => {
    fc.assert(
      fc.property(arbDecimal(6), (s) => {
        const a = parseUsdc6(s);
        expect(parseUsdc6(formatUsdc6(a))).toBe(a);
      }),
    );
  });

  it("parseUsdc18 -> formatUsdc18 -> parseUsdc18 is stable", () => {
    fc.assert(
      fc.property(arbDecimal(18), (s) => {
        const a = parseUsdc18(s);
        expect(parseUsdc18(formatUsdc18(a))).toBe(a);
      }),
    );
  });

  it("format of a Usdc6 equals the format of its Usdc18 lift", () => {
    fc.assert(
      fc.property(arbBig(10n ** 40n), (raw) => {
        const a = usdc6(raw);
        expect(formatUsdc18(toUsdc18(a))).toBe(formatUsdc6(a));
      }),
    );
  });

  it("rejects too many fractional digits and garbage", () => {
    expect(() => parseUsdc6("1.1234567")).toThrow(AccountingError);
    expect(() => parseUsdc18("1.1234567890123456789")).toThrow(AccountingError);
    expect(() => parseUsdc6("abc")).toThrow(AccountingError);
    expect(() => parseUsdc6("1e6")).toThrow(AccountingError);
    expect(() => parseUsdc6("")).toThrow(AccountingError);
    expect(parseUsdc6("  0.5 ")).toBe(500_000n);
    expect(parseUsdc6("-0.000001")).toBe(-1n);
  });

  it("formats with fraction digit options (truncating, never rounding)", () => {
    expect(formatUsdc18(parseUsdc18("0.0123456789"), { maxFractionDigits: 4 })).toBe("0.0123");
    expect(formatUsdc6(usdc6(1_000_000n), { minFractionDigits: 2 })).toBe("1.00");
    expect(formatUsdc18(usdc18(0n))).toBe("0");
    expect(formatUsdc18(usdc18(-1n))).toBe("-0.000000000000000001");
  });
});

describe("gas fees", () => {
  it("fee = gasUsed * effectiveGasPrice in 18-decimal units", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 1n << 40n }),
        fc.bigInt({ min: 0n, max: 1n << 80n }),
        (gas, price) => {
          expect(txFee18(gas, price)).toBe(gas * price);
        },
      ),
    );
  });

  it("a 21k-gas transfer at the 20 gwei floor costs 0.00042 USDC", () => {
    // 20 gwei = testnet minimum base fee (docs.arc.io/arc/references/gas-and-fees, 2026-09-14)
    const fee = txFee18(21_000n, gweiToUsdc18(20n));
    expect(formatUsdc18(fee)).toBe("0.00042");
    expect(() => toUsdc6Exact(fee)).not.toThrow();
    expect(toUsdc6Exact(fee)).toBe(420n);
  });

  it("reads receipt hex fields", () => {
    // real Arc testnet receipt fields observed 2026-09-14
    const fee = txFee18FromReceipt({ gasUsed: "0xcd2fc", effectiveGasPrice: "0x13122641ac" });
    expect(fee).toBe(0xcd2fcn * 0x13122641acn);
    expect(formatUsdc18(fee, { maxFractionDigits: 8 })).toBe("0.06883982");
  });

  it("rejects negative gas inputs and malformed hex", () => {
    expect(() => txFee18(-1n, 1n)).toThrow(AccountingError);
    expect(() => hexQuantityToBigInt("12")).toThrow(AccountingError);
    expect(() => hexQuantityToBigInt("0x")).toThrow(AccountingError);
    expect(() => hexQuantityToBigInt("0xzz")).toThrow(AccountingError);
    expect(hexQuantityToBigInt("0x0")).toBe(0n);
  });
});

describe("branding", () => {
  it("arithmetic helpers keep the brand", () => {
    const a = addUsdc6(usdc6(1n), usdc6(2n));
    expect(a).toBe(3n);
  });
});

describe("headroom under a cap", () => {
  it("is what is left, and never a debt", async () => {
    const { headroomUsdc6, usdc6 } = await import("../src/index.js");
    expect(headroomUsdc6(usdc6(5_000_000n), usdc6(310_500n))).toBe(4_689_500n);
    expect(headroomUsdc6(usdc6(100n), usdc6(100n))).toBe(0n);
    expect(headroomUsdc6(usdc6(100n), usdc6(250n))).toBe(0n);
  });
});
