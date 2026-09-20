import { describe, expect, it } from "vitest";
import { usdc6 } from "@cra-agent/accounting";
import { refuse, type GuardRules } from "../src/guard.js";

const OURS = "0x33b37c6d7a98b58da3ccb3f36a4b578053d0ea74";
const USDC = "0x3600000000000000000000000000000000000000";
const rules: GuardRules = { payTo: new Set([OURS]), assets: new Map([["eip155:5042", USDC]]), minAmount: usdc6(1n), maxAmount: usdc6(1_000_000n) };
const ok = { scheme: "exact", network: "eip155:5042", asset: USDC, payTo: "0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74", amount: "500" };

describe("what a private facilitator agrees to settle", () => {
  it("settles a payment to us, whatever the case of the address", () => {
    expect(refuse(ok, rules)).toBeNull();
  });

  it("refuses to be a free relayer: a payment to anyone else is not ours to pay gas for", () => {
    expect(refuse({ ...ok, payTo: "0x000000000000000000000000000000000000dEaD" }, rules)).toMatch(/does not settle for/);
  });

  it("refuses another network, another asset and another scheme", () => {
    expect(refuse({ ...ok, network: "eip155:8453" }, rules)).toMatch(/network/);
    expect(refuse({ ...ok, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, rules)).toMatch(/asset/);
    expect(refuse({ ...ok, scheme: "upto" }, rules)).toMatch(/scheme/);
  });

  it("keeps the amount inside the range, and rejects anything that is not a plain integer", () => {
    expect(refuse({ ...ok, amount: "0" }, rules)).toMatch(/below/);
    expect(refuse({ ...ok, amount: "1000001" }, rules)).toMatch(/above/);
    for (const amount of ["-5", "1e6", "0x10", "12.5", "", " 5"]) expect(refuse({ ...ok, amount }, rules), amount).toMatch(/whole number/);
  });

  it("allows nothing when it was told about nobody", () => {
    expect(refuse(ok, { ...rules, payTo: new Set() })).toMatch(/does not settle for/);
  });
});
