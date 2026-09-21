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
