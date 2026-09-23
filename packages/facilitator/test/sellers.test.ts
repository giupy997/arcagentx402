import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { refuse } from "../src/guard.js";
import { allowanceRefusal, SellerRegistry } from "../src/sellers.js";

const A = "0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74";
const B = "0xe5a67b7ddf06A6e63A8e0423195aA3b76002cF2B";

describe("sellers that register while running", () => {
  it("are allowed by the guard once added, and survive a restart", () => {
    const file = join(mkdtempSync(join(tmpdir(), "fac-")), "sellers.json");
    const r = new SellerRegistry(file, 200);
    const rules = { payTo: new Set<string>(), assets: new Map([["eip155:5042", "0x3600000000000000000000000000000000000000"]]), minAmount: 1n as never, maxAmount: 1_000_000n as never, registered: r };
    const req = { scheme: "exact", network: "eip155:5042", asset: "0x3600000000000000000000000000000000000000", payTo: A, amount: "3000" };
    expect(refuse(req, rules)).toMatch(/register the wallet first/);
    expect(r.add(A)).toBe(true);
    expect(refuse(req, rules)).toBeNull();
    expect(refuse({ ...req, payTo: B }, rules)).toMatch(/register/);
    expect(JSON.parse(readFileSync(file, "utf8")).sellers[A.toLowerCase()]).toBeTruthy();
    expect(new SellerRegistry(file, 200).has(A)).toBe(true);
    expect(r.add("nope")).toBe(false);
  });

  it("stops at the daily allowance and starts again the next UTC day", () => {
    let now = Date.parse("2026-09-22T23:59:00Z");
    const r = new SellerRegistry(null, 3, () => now);
    r.add(A);
    for (let i = 0; i < 3; i++) {
      expect(r.refuse(A)).toBeNull();
      r.recordSettlement(A);
    }
    expect(r.refuse(A)).toMatch(/daily allowance of 3/);
    expect(r.status(A)).toMatchObject({ registered: true, settledToday: 3, dailyCap: 3 });
    now = Date.parse("2026-09-23T00:01:00Z");
    expect(r.refuse(A)).toBeNull();
    expect(r.settledToday(A)).toBe(0);
    // A seller named at start has no allowance to hit: the registry says nothing about it.
    expect(r.refuse(B)).toBeNull();
  });
});

describe("what a free wallet cannot do to our gas", () => {
  const OURS = "0x33b37c6d7a98b58da3ccb3f36a4b578053d0ea74";
  const fixed = new Set([OURS]);
  const wallets = Array.from({ length: 10 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);

  it("stops a crowd of registered wallets at the shared allowance, whatever each one's own", () => {
    const r = new SellerRegistry(null, 200, () => Date.parse("2026-09-23T10:00:00Z"), 25);
    for (const w of wallets) r.add(w);
    let settled = 0;
    for (let round = 0; round < 10; round++) {
      for (const w of wallets) {
        if (allowanceRefusal(w, fixed, r, 10n ** 18n, 0n) === null) {
          r.recordSettlement(w);
          settled++;
        }
      }
    }
    expect(settled).toBe(25);
    expect(allowanceRefusal(wallets[0]!, fixed, r, 10n ** 18n, 0n)).toMatch(/shared by all registered sellers/);
    // Our own address is not counted and never stopped by it.
    expect(allowanceRefusal(OURS, fixed, r, 10n ** 18n, 0n)).toBeNull();
  });

  it("keeps the gas reserve for our own addresses", () => {
    const r = new SellerRegistry(null, 200);
    r.add(wallets[0]!);
    const reserve = 5n * 10n ** 17n; // 0.5 USDC
    expect(allowanceRefusal(wallets[0]!, fixed, r, reserve - 1n, reserve)).toMatch(/low on gas/);
    expect(allowanceRefusal(wallets[0]!, fixed, r, reserve, reserve)).toBeNull();
    expect(allowanceRefusal(OURS, fixed, r, 1n, reserve)).toBeNull();
    // An unreadable balance does not block: the settlement itself would fail if the gas were gone.
    expect(allowanceRefusal(wallets[0]!, fixed, r, null, reserve)).toBeNull();
  });

  it("does not count our own settlements against the shared allowance", () => {
    const r = new SellerRegistry(null, 200, Date.now, 2);
    r.add(wallets[0]!);
    for (let i = 0; i < 5; i++) r.recordSettlement(OURS);
    expect(r.sharedSettledToday).toBe(0);
    expect(allowanceRefusal(wallets[0]!, fixed, r, null, 0n)).toBeNull();
  });
});
