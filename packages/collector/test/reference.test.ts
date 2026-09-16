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

  it("is not dragged by the odd bad leg between good trades", () => {
    const ref = new ReferencePrice(0.05);
    ref.seed(seedOf(1.155));
    for (let i = 0; i < 20; i++) {
      expect(ref.accept(0.54)).toBe(false);
      expect(ref.accept(1.156)).toBe(true); // a good trade resets the run
    }
    expect(ref.median).toBeCloseTo(1.156, 3);
  });
});

describe("a reference that has fallen behind", () => {
  it("adopts a new level once the rejected rates agree with each other", () => {
    const ref = new ReferencePrice(0.35);
    ref.seed(Array.from({ length: 10 }, () => 0.0001));
    // The price jumps and stays there: the first ones are rejected, then the level is taken up.
    const results = Array.from({ length: 10 }, () => ref.accept(0.00028));
    expect(results.slice(0, 7)).toEqual(Array(7).fill(false));
    expect(results.at(-1)).toBe(true);
    expect(ref.median).toBeCloseTo(0.00028, 6);
  });

  it("never adopts rates that disagree with each other", () => {
    const ref = new ReferencePrice(0.05);
    ref.seed(Array.from({ length: 10 }, () => 1.155));
    const junk = [0.54, 1.92, 0.61, 1.77, 0.52, 1.88, 0.55, 1.9, 0.6, 1.8, 0.53, 1.85];
    for (const r of junk) expect(ref.accept(r)).toBe(false);
    expect(ref.median).toBeCloseTo(1.155, 3);
  });
});
