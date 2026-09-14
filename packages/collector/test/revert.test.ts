import { describe, expect, it } from "vitest";
import { decodeRevertData, extractRevertData } from "../src/workers/enrich.js";

describe("decodeRevertData", () => {
  it("decodes Error(string)", () => {
    // Error("Fee transfer failed")
    const msg = Buffer.from("Fee transfer failed").toString("hex");
    const data = "0x08c379a0" + "20".padStart(64, "0") + (19).toString(16).padStart(64, "0") + msg.padEnd(64, "0");
    expect(decodeRevertData(data)).toEqual({ kind: "error_string", reason: "Fee transfer failed" });
  });
  it("decodes Panic(uint256)", () => {
    expect(decodeRevertData("0x4e487b71" + "11".padStart(64, "0"))).toEqual({ kind: "panic", reason: "Panic(0x11): arithmetic overflow/underflow" });
  });
  it("labels custom errors by selector and empty data", () => {
    expect(decodeRevertData("0xdeadbeef" + "00".repeat(32))).toEqual({ kind: "custom", reason: "0xdeadbeef" });
    expect(decodeRevertData("0x")).toEqual({ kind: "empty", reason: null });
    expect(decodeRevertData(null)).toEqual({ kind: "empty", reason: null });
  });
});

describe("extractRevertData", () => {
  it("handles the common node error shapes", () => {
    expect(extractRevertData({ data: "0x08c379a0aa" })).toBe("0x08c379a0aa");
    expect(extractRevertData({ data: { data: "0x1234abcd" } })).toBe("0x1234abcd");
    expect(extractRevertData({ message: "execution reverted: 0x4e487b7100000000000000000000000000000000000000000000000000000000000000011" })).toMatch(/^0x4e487b71/);
    expect(extractRevertData({ message: "execution reverted" })).toBeNull();
  });
});
