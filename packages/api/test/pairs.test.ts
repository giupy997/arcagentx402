import { describe, expect, it } from "vitest";
import { resolvePair } from "../src/pairs.js";

describe("which pair a caller means", () => {
  it("answers to the token's own symbol in any case, and to the plain name", () => {
    for (const q of ["cirBTC", "CIRBTC", "cirbtc", "btc", "Bitcoin"]) expect(resolvePair(q), q).toEqual({ symbol: "cirBTC", decimals: 8 });
    for (const q of ["WETH", "eth"]) expect(resolvePair(q), q).toEqual({ symbol: "WETH", decimals: 18 });
    expect(resolvePair(undefined)).toEqual({ symbol: "EURC", decimals: 6 });
    expect(resolvePair("CRA")?.decimals).toBe(18);
  });
  it("says no to a pair we do not price, instead of answering with another one's scale", () => {
    expect(resolvePair("DOGE")).toBeNull();
  });
});

import { formatBaseAmount } from "../src/queries.js";

describe("a traded amount, for a reader", () => {
  it("keeps bitcoin-sized amounts readable instead of rounding them to zero", () => {
    expect(formatBaseAmount("54334", 8)).toBe("0.0005433"); // a $47 trade at $86,538
    expect(formatBaseAmount("100", 8)).toBe("0.000001");
    expect(formatBaseAmount("150000000", 8)).toBe("1.5");
    expect(formatBaseAmount("0", 8)).toBe("0");
  });
  it("shows amounts of a hundred and more with two decimals, and smaller ones with four", () => {
    expect(formatBaseAmount("1234567890", 6)).toBe("1,234.56");
    expect(formatBaseAmount("24706070000000000000000", 18)).toBe("24,706.07");
    expect(formatBaseAmount("5500000", 6)).toBe("5.5");
    expect(formatBaseAmount("12345678", 6)).toBe("12.3456");
  });
});
