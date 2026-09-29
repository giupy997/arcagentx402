import { describe, expect, it } from "vitest";
import { parseSweepArgs } from "../src/sell-args.js";

const ARC = "0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74";

describe("the sweep command", () => {
  it("reads its options", () => {
    expect(parseSweepArgs(["--solana-key-file", "/k", "--to", ARC, "--amount", "1.5", "--max-fee", "0.001", "--dry-run"])).toEqual({ solanaKeyFile: "/k", to: ARC, amount: 1_500_000n, maxFee: 1000n, dryRun: true });
    expect(parseSweepArgs(["--solana-key-file", "/k", "--to", ARC])).toEqual({ solanaKeyFile: "/k", to: ARC, dryRun: false });
    expect(() => parseSweepArgs(["--to", ARC])).toThrow(/--solana-key-file/);
    expect(() => parseSweepArgs(["--solana-key-file", "/k", "--to", "26SsHut3dRbK9cWUJcrMfkKn3TKXSFMw61zyqm6tgWjK"])).toThrow(/0x address on Arc/);
    expect(() => parseSweepArgs(["--solana-key-file", "/k", "--to", ARC, "--amount", "all"])).toThrow(/amount in USDC/);
  });
});
