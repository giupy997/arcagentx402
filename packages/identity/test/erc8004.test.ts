import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { createErc8004Resolver, scanRegistry, type RegistryReader } from "../src/index.js";

const OWNER = "0x024b82335C29Fa5606a8ea5c1D24FC9eAD50700C" as Address;
const PAYEE = "0xd334ab5151aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const OTHER = "0x9F408De79d38257DfB6D73C9DA7d9c81D744377c" as Address;
const NOBODY = "0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74" as Address;

/** A registry of `count` agents: #1 declared PAYEE as its wallet, #3 and #4 belong to OTHER, the rest to OWNER. */
function registry(count: number, calls = { agents: 0 }): RegistryReader {
  const owner = (i: number): Address => (i === 3 || i === 4 ? OTHER : OWNER);
  return {
    balanceOf: async (a) => BigInt(Array.from({ length: count }, (_, i) => owner(i)).filter((o) => o.toLowerCase() === a.toLowerCase()).length),
    agents: async (ids) => {
      calls.agents++;
      return ids.map((id) => (Number(id) < count ? { owner: owner(Number(id)), wallet: Number(id) === 1 ? PAYEE : null } : null));
    },
    tokenURI: async (id) => `https://example.test/agent/${id}.json`,
  };
}

describe("reading the registry", () => {
  it("finds every agent from id 0, in pages, and stops at the first empty id", async () => {
    const calls = { agents: 0 };
    const r = await scanRegistry(registry(186, calls), 5000, 100);
    expect(r.agents.map((a) => Number(a.agentId))).toEqual(Array.from({ length: 186 }, (_, i) => i));
    expect(r.complete).toBe(true);
    expect(calls.agents).toBe(2);
  });

  it("says when it gave up before the end", async () => {
    const r = await scanRegistry(registry(1000), 300, 100);
    expect(r.agents).toHaveLength(300);
    expect(r.complete).toBe(false);
  });
});

describe("who counts as an identified seller", () => {
  it("an owner, with the ids it owns", async () => {
    const r = await createErc8004Resolver({ network: "arc", reader: registry(6) }).resolve(OTHER);
    expect(r).toMatchObject({ verified: true, agentIds: [3n, 4n], metadataURI: "https://example.test/agent/3.json", error: null });
  });

  it("a wallet an agent declared for payments, even though it owns nothing", async () => {
    const r = await createErc8004Resolver({ network: "arc", reader: registry(6) }).resolve(PAYEE);
    expect(r).toMatchObject({ verified: true, agentIds: [1n] });
  });

  it("nobody else", async () => {
    const r = await createErc8004Resolver({ network: "arc", reader: registry(6) }).resolve(NOBODY);
    expect(r).toMatchObject({ verified: false, agentIds: [], error: null });
  });

  it("falls back to ownership alone when the list cannot be read, and fails closed when nothing can", async () => {
    const listDown: RegistryReader = { ...registry(6), agents: async () => { throw new Error("rpc down"); } };
    expect(await createErc8004Resolver({ network: "arc", reader: listDown }).resolve(OTHER)).toMatchObject({ verified: true, agentIds: [] });
    expect(await createErc8004Resolver({ network: "arc", reader: listDown }).resolve(PAYEE)).toMatchObject({ verified: false });
    const allDown: RegistryReader = { ...listDown, balanceOf: async () => { throw new Error("rpc down"); } };
    expect(await createErc8004Resolver({ network: "arc", reader: allDown }).resolve(OTHER)).toMatchObject({ verified: false });
  });

  it("reads the registry once for many addresses", async () => {
    const calls = { agents: 0 };
    const resolver = createErc8004Resolver({ network: "arc", reader: registry(6, calls) });
    await resolver.resolve(OTHER);
    await resolver.resolve(PAYEE);
    await resolver.resolve(NOBODY);
    expect(calls.agents).toBe(1);
  });
});
