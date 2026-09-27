import { describe, expect, it } from "vitest";
import { ECO_PORTAL, moveFrom } from "../src/lane.js";

const OWNER = "26SsHut3dRbK9cWUJcrMfkKn3TKXSFMw61zyqm6tgWjK";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const balance = (owner: string, amount: string, mint = USDC) => ({ mint, owner, uiTokenAmount: { amount } });
const tx = (o: { program?: string; err?: unknown; pre?: string; post?: string; owner?: string } = {}) => ({
  blockTime: 1_790_600_000,
  meta: { err: o.err ?? null, preTokenBalances: [balance(o.owner ?? OWNER, o.pre ?? "1501000")], postTokenBalances: [balance(o.owner ?? OWNER, o.post ?? "1000")] },
  transaction: { signatures: ["5igSig"], message: { instructions: [{ programId: "ComputeBudget111111111111111111111111111111" }, { programId: o.program ?? ECO_PORTAL }] } },
});

describe("moves from Solana to Arc, read back from Solana", () => {
  it("counts a deposit of our USDC into Eco's Portal, by how much our balance fell", () => {
    expect(moveFrom(tx(), OWNER)).toEqual({ signature: "5igSig", at: 1_790_600_000, amountUsdc6: 1_500_000n });
  });

  it("ignores failed transactions, other programs, other wallets and money coming in", () => {
    expect(moveFrom(tx({ err: { InstructionError: [1, "Custom"] } }), OWNER)).toBeNull();
    expect(moveFrom(tx({ program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }), OWNER)).toBeNull();
    expect(moveFrom(tx({ owner: "Someone1111111111111111111111111111111111" }), OWNER)).toBeNull();
    expect(moveFrom(tx({ pre: "1000", post: "1001000" }), OWNER)).toBeNull();
    expect(moveFrom(null, OWNER)).toBeNull();
  });
});
