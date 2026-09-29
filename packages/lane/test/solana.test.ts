import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ARC_CCTP_DOMAIN, SweepRefused } from "../src/common.js";
import { checkEcoQuote, readBurn, readSolanaSigner } from "../src/solana.js";
import quote from "./fixtures/eco-quote-solana-arc.json";

// A real quote from Eco (27 Sep 2026): 1.5 USDC from our Solana wallet to our wallet on Arc.
const FUNDER = "26SsHut3dRbK9cWUJcrMfkKn3TKXSFMw61zyqm6tgWjK";
const ARC = "0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74";
const ok = { funder: FUNDER, recipient: ARC, amount: 1_500_000n, maxFee: 10_000n, now: quote.expiresAt - 30 };
const copy = () => JSON.parse(JSON.stringify(quote)) as typeof quote;
const refused = (q: unknown, e = ok) => {
  try {
    checkEcoQuote(q as Record<string, unknown>, e);
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(SweepRefused);
    return (err as Error).message;
  }
};

describe("checking Eco's quote before anything is signed", () => {
  it("accepts the real quote and reads what it promises", () => {
    const c = checkEcoQuote(quote, ok);
    expect(c).toMatchObject({ amount: 1_500_000n, minAmountOut: 1_499_700n, fee: 300n, etaSeconds: 7 });
    expect(c.instruction.programId).toBe("EcooswwC1NggsckZyF5SeAL9WsgJs3UhPbrqY1apV73F");
  });

  it("reads the CCTP burn inside it: to Arc's domain, for our address", () => {
    expect(readBurn(quote.execution.intent.route.calls[0]!.data)).toEqual({ amount: 1_500_000n, domain: ARC_CCTP_DOMAIN, recipient: ARC.toLowerCase(), maxFee: 300n });
    expect(readBurn("0x1234")).toBeNull();
  });

  it("refuses a quote that pays someone else, anywhere it could be said", () => {
    const dest = copy();
    dest.destination.recipient = "0x000000000000000000000000000000000000dEaD";
    expect(refused(dest)).toMatch(/another Arc address/);
    // The burn itself names another recipient, while the summary still says ours.
    const burn = copy();
    burn.execution.intent.route.calls[0]!.data = burn.execution.intent.route.calls[0]!.data.replace(ARC.slice(2).toLowerCase(), "000000000000000000000000000000000000dead");
    expect(refused(burn)).toMatch(/mints to another address/);
    const refund = copy();
    refund.execution.intent.reward.creator = "11111111111111111111111111111111";
    expect(refused(refund)).toMatch(/refund goes to another wallet/);
  });

  it("refuses another chain, another program, another signer, a bigger fee or an old quote", () => {
    const domain = copy();
    domain.execution.intent.route.calls[0]!.data = domain.execution.intent.route.calls[0]!.data.replace("1a000000", "06000000");
    expect(refused(domain)).toMatch(/CCTP domain 6/);
    const program = copy();
    program.execution.transaction.instructions[0]!.programId = "11111111111111111111111111111111";
    expect(refused(program)).toMatch(/not Eco's Portal/);
    const signer = copy();
    signer.execution.transaction.instructions[0]!.accounts[2]!.isSigner = true;
    expect(refused(signer)).toMatch(/another account to sign/);
    expect(refused(quote, { ...ok, maxFee: 299n })).toMatch(/over the cap/);
    expect(refused(quote, { ...ok, now: quote.expiresAt + 1 })).toMatch(/expired/);
    expect(refused(quote, { ...ok, amount: 1_000_000n })).toMatch(/not 1000000/);
  });
});

describe("a Solana key file", () => {
  it("takes a key as our hex seed or as solana-keygen's array, to the same wallet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sweep-"));
    const seed = Buffer.alloc(32, 7);
    writeFileSync(join(dir, "hex"), `${seed.toString("hex")}\n`);
    writeFileSync(join(dir, "json"), JSON.stringify([...seed, ...Buffer.alloc(32, 1)]));
    const a = await readSolanaSigner(join(dir, "hex"));
    const b = await readSolanaSigner(join(dir, "json"));
    expect(a.address).toBe(b.address);
    writeFileSync(join(dir, "bad"), "nostr+walletconnect://x");
    await expect(readSolanaSigner(join(dir, "bad"))).rejects.toThrow(/32-byte seed/);
  });
});
