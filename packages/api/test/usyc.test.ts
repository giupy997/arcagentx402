import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { annualized, decimal, roundBefore, summarize, usycReader, USYC_ARC, type Round } from "../src/usyc.js";

const E18 = 10n ** 18n;
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const price = (s: string) => BigInt(s.replace(".", "").padEnd(19, "0"));
// Rounds 60 and 65 of the USYC oracle on Arc, as published.
const R60: Round = { round: 60, at: at("2026-09-18T11:54:00Z"), price: price("1.137524376") };
const R65: Round = { round: 65, at: at("2026-09-25T12:40:11Z"), price: 1138263180605557151n };

describe("USYC's price, read as an agent would use it", () => {
  it("turns a week of price growth into a yearly rate", () => {
    expect(annualized(R60, R65)).toBe(3.43);
    expect(annualized(R65, R60)).toBeNull();
  });

  it("finds the round a window back, skipping the ones that are too recent", () => {
    const rounds = [{ ...R60, round: 1, at: R60.at - 40 * 86_400 }, R60, { ...R60, round: 64, at: R65.at - 86_400 }, R65];
    expect(roundBefore(rounds, 7)?.round).toBe(60);
    expect(roundBefore(rounds, 30)?.round).toBe(1);
    expect(roundBefore([R65], 7)).toBeNull();
  });

  it("prints fixed-point amounts without rounding them up", () => {
    expect(decimal(1138263180605557151n, 18, 6)).toBe("1.138263");
    expect(decimal(0n, 6)).toBe("0");
    expect(decimal(1_500_000n, 6)).toBe("1.5");
  });

  it("says what one USYC is worth, how fast it grew and how much exists on Arc", () => {
    const v = summarize({ rounds: [R65, R60], decimals: 18, supply: 0n, tokenDecimals: 6, oracle: "0x4BC8d5aCD3d040d2903dD9C5B7048520c6ff537A", description: "USYC / USD", now: R65.at + 60 });
    expect(v.price).toMatchObject({ usd: "1.138263", round: 65, updatedAt: R65.at });
    expect(v.growth).toMatchObject({ annualized7d: 3.43, annualized30d: null });
    expect(v.supplyOnArc).toBe("0");
    expect(v.history.map((h) => h.round)).toEqual([60, 65]);
    expect(v.contracts.token).toBe(USYC_ARC.token);
  });
});

describe("reading USYC from Arc", () => {
  function fakeChain() {
    const asked: string[] = [];
    const oracle = "0x4BC8d5aCD3d040d2903dD9C5B7048520c6ff537A";
    let latest = 2;
    const history = new Map([
      [1, { at: at("2026-09-17T12:00:00Z"), p: E18 + 1000n }],
      [2, { at: at("2026-09-18T12:00:00Z"), p: E18 + 2000n }],
      [3, { at: at("2026-09-21T12:00:00Z"), p: E18 + 3000n }],
    ]);
    const client = {
      async readContract({ functionName, args }: { functionName: string; args?: readonly bigint[] }) {
        asked.push(functionName + (args ? `(${args[0]})` : ""));
        if (functionName === "oracle") return oracle;
        if (functionName === "latestRoundData") return [BigInt(latest), history.get(latest)!.p, 0n, BigInt(history.get(latest)!.at), BigInt(latest)];
        if (functionName === "getRoundData") {
          const r = Number(args![0]);
          return [BigInt(r), history.get(r)!.p, 0n, BigInt(history.get(r)!.at), BigInt(r)];
        }
        if (functionName === "decimals") return 18;
        if (functionName === "description") return "USYC / USD";
        if (functionName === "totalSupply") return 0n;
        throw new Error(functionName);
      },
    } as unknown as PublicClient;
    return { client, asked, publish: () => void (latest = 3) };
  }

  it("asks for each published price once, and only for new ones afterwards", async () => {
    const chain = fakeChain();
    const reader = usycReader([], { client: chain.client, ttlMs: 0 });
    expect((await reader.read()).history).toHaveLength(2);
    chain.publish();
    chain.asked.length = 0;
    const v = await reader.read();
    expect(v.price?.round).toBe(3);
    expect(chain.asked.filter((a) => a.startsWith("getRoundData"))).toEqual(["getRoundData(3)"]);
  });

  it("keeps the last good view when the chain stops answering", async () => {
    const chain = fakeChain();
    const reader = usycReader([], { client: chain.client, ttlMs: 0 });
    const first = await reader.read();
    (chain.client as unknown as { readContract: () => Promise<never> }).readContract = async () => {
      throw new Error("timeout");
    };
    expect(await reader.read()).toBe(first);
  });
});
