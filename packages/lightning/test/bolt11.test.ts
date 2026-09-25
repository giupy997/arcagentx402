import { describe, expect, it } from "vitest";
import { Bolt11Error, decodeBolt11, encodeBolt11, fromHex } from "../src/bolt11.js";

// The spec's example (scheme_exact_lnbtc.md): GET https://api.example.com/article/A, 25 sat, test key 0x..01.
const SPEC_INVOICE =
  "lnbc250n1pj48ugqpp54y3u9s8ylemsv8l3ewyzzu0klhujvuvmkl6llchq23vy8rzjsf0qsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygshp5p4nz8am4uqj4q8a87z3sk4x6yk4dv2mvel34epw68qqkwy0xcqvqxqzfvcqpjr4rx6ls6j5rpwknuea64evlk7yfx56wmqcer5eerekdsn9tlv6v4ex9mlz5dtm9qapl3svwlqcf7837dmjkru9z9w4h2rvm0md52w2sqxrwu5f";
const G = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const KEY = fromHex("0000000000000000000000000000000000000000000000000000000000000001");

describe("BOLT11, strictly", () => {
  it("reads the spec's example: amount, binding, expiry, time, and the key that signed it", () => {
    const d = decodeBolt11(SPEC_INVOICE);
    expect(d).toMatchObject({
      currency: "bc",
      amountMsat: "25000",
      timestamp: 1700000000,
      expiry: 300,
      descriptionHash: "0d6623f775e025501fa7f0a30b54da25aad62b6ccfe35c85da38016711e6c018",
      description: null,
      payee: G,
      payeeStated: false,
    });
    expect(d.paymentHash).toBe("a923c2c0e4fe77061ff1cb882171f6fdf926719bb7f5ffe2e05458438c52825e");
  });

  it("signs an invoice that decodes to what went in, recovering the signer", () => {
    const d0 = decodeBolt11(SPEC_INVOICE);
    const again = encodeBolt11({
      currency: "bc",
      amountMsat: 25000n,
      timestamp: d0.timestamp,
      paymentHash: fromHex(d0.paymentHash),
      paymentSecret: fromHex(d0.paymentSecret!),
      descriptionHash: fromHex(d0.descriptionHash!),
      expiry: 300,
      privateKey: KEY,
    });
    const d = decodeBolt11(again);
    expect(d).toMatchObject({ amountMsat: "25000", payee: G, paymentHash: d0.paymentHash, descriptionHash: d0.descriptionHash, expiry: 300, timestamp: 1700000000 });
    expect(again).toBe(SPEC_INVOICE);
  });

  it("refuses what a strict reader must: a changed character, another network, fractions of a millisatoshi", () => {
    const tampered = SPEC_INVOICE.slice(0, 40) + (SPEC_INVOICE[40] === "q" ? "p" : "q") + SPEC_INVOICE.slice(41);
    expect(() => decodeBolt11(tampered)).toThrow(Bolt11Error);
    expect(() => decodeBolt11(SPEC_INVOICE.replace("lnbc", "lnbcrt"))).toThrow(Bolt11Error);
    expect(() => decodeBolt11("lnbc1p1" + SPEC_INVOICE.slice(8))).toThrow(Bolt11Error);
    expect(() => decodeBolt11("")).toThrow(Bolt11Error);
  });

  it("writes the shortest amount and keeps millisatoshi precision", () => {
    const base = { currency: "tb" as const, timestamp: 1_700_000_000, paymentHash: new Uint8Array(32).fill(7), paymentSecret: new Uint8Array(32).fill(1), descriptionHash: new Uint8Array(32).fill(2), expiry: 600, privateKey: KEY };
    for (const [msat, prefix] of [[1_000n, "lntb10n"], [1n, "lntb10p"], [123_456_789n, "lntb1234567890p"], [100_000_000_000n, "lntb1"], [2_100_000n, "lntb21u"]] as const) {
      const inv = encodeBolt11({ ...base, amountMsat: msat });
      expect(inv.startsWith(prefix + "1")).toBe(true);
      expect(decodeBolt11(inv)).toMatchObject({ amountMsat: String(msat), currency: "tb", expiry: 600, payee: G });
    }
  });
});
