import { describe, expect, it } from "vitest";
import { keccak256, toHex } from "viem";
import { AGENTIC_COMMERCE_ABI, jobStatusFromCode, reasonHash } from "../src/index.js";

describe("ERC-8183 client", () => {
  it("maps the status enum in contract order", () => {
    expect([0, 1, 2, 3, 4, 5].map(jobStatusFromCode)).toEqual(["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"]);
    expect(() => jobStatusFromCode(6)).toThrow();
  });
  it("hashes reasons as keccak256 of the utf8 string", () => {
    expect(reasonHash("work-delivered-and-approved")).toBe(keccak256(toHex("work-delivered-and-approved")));
  });
  it("carries the selectors present in the verified implementation", () => {
    // selectors verified against bytecode of impl 0xa316fd02827242d537f84730f8a37d0ba5fd351a on 2026-09-15
    const names = AGENTIC_COMMERCE_ABI.filter((x) => x.type === "function").map((x) => x.name);
    for (const n of ["createJob", "setBudget", "fund", "submit", "complete", "reject", "claimRefund", "getJob", "jobCounter"]) expect(names).toContain(n);
  });
});
