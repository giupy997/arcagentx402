import { describe, expect, it } from "vitest";
import { parseUsdc6 } from "@arc-rail/accounting";
import { chooseRail } from "../src/decide.js";

describe("chooseRail", () => {
  it("small pay-per-call goes to nanopayment", () => {
    expect(chooseRail({ amount: parseUsdc6("0.001"), kind: "call", supportsBatching: true, maxTimeoutSeconds: 60 }).rail).toBe("nanopayment");
    expect(chooseRail({ amount: parseUsdc6("0.001"), kind: "call", supportsBatching: false, maxTimeoutSeconds: 60 }).rail).toBe("nanopayment");
  });
  it("jobs and large amounts go to escrow", () => {
    expect(chooseRail({ amount: parseUsdc6("0.001"), kind: "job", supportsBatching: true, maxTimeoutSeconds: 60 }).rail).toBe("escrow");
    expect(chooseRail({ amount: parseUsdc6("5.000001"), kind: "call", supportsBatching: true, maxTimeoutSeconds: 60 }).rail).toBe("escrow");
    expect(chooseRail({ amount: parseUsdc6("5"), kind: "call", supportsBatching: true, maxTimeoutSeconds: 60 }).rail).toBe("nanopayment");
  });
});
