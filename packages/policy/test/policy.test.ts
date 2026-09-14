import { describe, expect, it } from "vitest";
import { parseUsdc6, usdc6 } from "@arc-rail/accounting";
import { ARC_TESTNET, DEFAULT_POLICY, evaluatePolicy, parsePolicyString, type PolicyContext } from "../src/index.js";

const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  amount: parseUsdc6("0.001"), network: ARC_TESTNET, payTo: "0xSELLER", host: "api.example.com",
  spentInWindow: usdc6(0n), spentInWindowWithCounterparty: usdc6(0n), paymentsInRateWindow: 0, identityVerified: null, sellerBond: null, ...over,
});

describe("evaluatePolicy", () => {
  it("allows a small payment under defaults", () => {
    expect(evaluatePolicy(DEFAULT_POLICY, ctx())).toEqual({ allow: true });
  });
  it("rejects in rule order: network, deny, allow, per_payment, rate, daily, per_counterparty, identity, bond", () => {
    expect(evaluatePolicy(DEFAULT_POLICY, ctx({ network: "eip155:8453" }))).toMatchObject({ allow: false, rule: "network" });
    expect(evaluatePolicy({ ...DEFAULT_POLICY, denylist: ["API.example.com"] }, ctx())).toMatchObject({ rule: "denylist" });
    expect(evaluatePolicy({ ...DEFAULT_POLICY, allowlist: ["other.com"] }, ctx())).toMatchObject({ rule: "allowlist" });
    expect(evaluatePolicy({ ...DEFAULT_POLICY, allowlist: ["0xseller"] }, ctx())).toEqual({ allow: true });
    expect(evaluatePolicy(DEFAULT_POLICY, ctx({ amount: parseUsdc6("0.06") }))).toMatchObject({ rule: "per_payment" });
    expect(evaluatePolicy(DEFAULT_POLICY, ctx({ paymentsInRateWindow: 120 }))).toMatchObject({ rule: "rate" });
    expect(evaluatePolicy(DEFAULT_POLICY, ctx({ spentInWindow: parseUsdc6("4.9995") }))).toMatchObject({ rule: "daily" });
    expect(evaluatePolicy(DEFAULT_POLICY, ctx({ spentInWindowWithCounterparty: parseUsdc6("1") }))).toMatchObject({ rule: "per_counterparty" });
    expect(evaluatePolicy({ ...DEFAULT_POLICY, requireVerifiedIdentity: true }, ctx())).toMatchObject({ rule: "identity" });
    expect(evaluatePolicy({ ...DEFAULT_POLICY, requireVerifiedIdentity: true }, ctx({ identityVerified: true }))).toEqual({ allow: true });
    expect(evaluatePolicy({ ...DEFAULT_POLICY, requiredSellerBond: parseUsdc6("10") }, ctx({ sellerBond: parseUsdc6("9") }))).toMatchObject({ rule: "bond" });
    expect(evaluatePolicy({ ...DEFAULT_POLICY, requiredSellerBond: parseUsdc6("10") }, ctx({ sellerBond: parseUsdc6("10") }))).toEqual({ allow: true });
  });
  it("caps are inclusive: exactly at the cap is allowed", () => {
    expect(evaluatePolicy(DEFAULT_POLICY, ctx({ amount: parseUsdc6("0.05") }))).toEqual({ allow: true });
    expect(evaluatePolicy(DEFAULT_POLICY, ctx({ amount: parseUsdc6("0.05"), spentInWindow: parseUsdc6("4.95") }))).toEqual({ allow: true });
  });
});

describe("parsePolicyString", () => {
  it("parses the compact syntax", () => {
    const p = parsePolicyString("daily=5.00,per_seller=0.50,per_payment=0.01,rate=10/1m,identity=required,allow=api.a.com|0xABC,networks=eip155:5042");
    expect(p.dailyCap).toBe(5_000_000n);
    expect(p.perCounterpartyDailyCap).toBe(500_000n);
    expect(p.perPaymentCap).toBe(10_000n);
    expect(p.rateLimit).toEqual({ maxPayments: 10, windowMs: 60_000 });
    expect(p.requireVerifiedIdentity).toBe(true);
    expect(p.allowlist).toEqual(["api.a.com", "0xabc"]);
    expect(p.allowedNetworks).toEqual(["eip155:5042"]);
  });
  it("rejects unknown keys and malformed values (a typo must not widen a limit)", () => {
    expect(() => parsePolicyString("dialy=100")).toThrow(/unknown key/);
    expect(() => parsePolicyString("rate=fast")).toThrow(/rate/);
    expect(() => parsePolicyString("daily")).toThrow(/key=value/);
  });
});
