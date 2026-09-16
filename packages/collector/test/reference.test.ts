import { describe, expect, it } from "vitest";
import { ReferencePrice } from "../src/ingest/reference.js";

const seedOf = (value: number, n = 10): number[] => Array.from({ length: n }, () => value);

describe("running reference price", () => {
  it("accepts everything until it has seen enough", () => {
    const ref = new ReferencePrice(0.05);
    expect(ref.median).toBeNull();
    for (let i = 0; i < 8; i++) expect(ref.accept(0.0001 * (i + 1))).toBe(true);
    expect(ref.median).not.toBeNull();
  });

  it("rejects a rate far from the running price, and keeps one near it", () => {
    const ref = new ReferencePrice(0.05);
    ref.seed(seedOf(1.155));
    expect(ref.accept(1.16)).toBe(true);
    expect(ref.accept(0.54)).toBe(false); // a mispriced leg on a stablecoin pair
    expect(ref.accept(1.92)).toBe(false);
  });

  it("follows a market that moves", () => {
    const ref = new ReferencePrice(0.35);
    ref.seed(seedOf(0.0001));
    let rate = 0.0001;
    // A hard climb: half a percent a trade, tripling over eighty trades, and none is rejected.
    for (let i = 0; i < 80; i++) {
      rate *= 1.015;
      expect(ref.accept(rate)).toBe(true);
    }
    expect(ref.median!).toBeGreaterThan(0.00025); // the reference climbed with it
  });

  it("is not dragged by a run of rejected rates", () => {
    const ref = new ReferencePrice(0.05);
    ref.seed(seedOf(1.155));
    for (let i = 0; i < 20; i++) ref.accept(0.011);
    expect(ref.median).toBeCloseTo(1.155, 3);
  });
});
