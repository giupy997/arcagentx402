import { describe, expect, it } from "vitest";
import type { RegistryReader } from "@cra-agent/identity";
import { ipfsCandidates, labelsFromCircle, labelsFromFacilitators, labelsFromMarket, labelsFromRegistry, readRegistry, readRegistryFrom, signersFromSupported, type RegistryEntry } from "../src/labels.js";
import type { SearchItem } from "../src/search.js";

const EXA = "0xB98eF29eb2be19Ae646A8FC0248255B90A332dbC";
const APEX_PAYEE = "0xd334ab5151c624cada654854e2879903dc4217ed";
const APEX_WALLET = "0x024b82335c29fa5606a8ea5c1d24fc9ead50700c";

const item = (over: Partial<SearchItem>): SearchItem => ({ url: "https://api.exa.ai/search", method: "POST", priceUsd: "0.007", name: "Exa", label: "Search the web", description: "AI web search", params: [], payTo: EXA, host: "api.exa.ai", network: "eip155:5042", rail: "gateway", direct: null, body: null, source: "circle", category: "Web search & research", site: "https://exa.ai", networks: ["eip155:5042"], plainNetworks: [], online: true, keywords: "", ...over });

describe("labels that public sources give an address", () => {
  it("names the payee of a Circle catalogue entry as its seller, once per seller", () => {
    const labels = labelsFromCircle([item({}), item({ url: "https://api.exa.ai/contents" }), item({ payTo: "0x123" })]);
    expect(labels).toEqual([{ address: EXA.toLowerCase(), role: "seller", name: "Exa", url: "https://api.exa.ai", source: "circle", detail: "AI web search" }]);
  });

  it("names the payee of a market listing, falling back to its host", () => {
    expect(labelsFromMarket([{ url: "https://a.example/x", host: "a.example", name: null, description: null, pay_to: APEX_PAYEE }])).toEqual([{ address: APEX_PAYEE, role: "seller", name: "a.example", url: "https://a.example/x", source: "market", detail: null }]);
  });

  it("reads a facilitator's signers for every EVM chain or for Arc, and nothing else", () => {
    expect(signersFromSupported({ signers: { "eip155:*": ["0xD407e409E34E0b9afb99EcCeb609bDbcD5e7f1bf", "nope"], "eip155:8453": ["0x0000000000000000000000000000000000000001"], "eip155:5042": ["0x0000000000000000000000000000000000000002"], "solana:*": ["So1ana"] } })).toEqual([
      "0xd407e409e34e0b9afb99ecceb609bdbcd5e7f1bf",
      "0x0000000000000000000000000000000000000002",
    ]);
    expect(signersFromSupported({ kinds: [] })).toEqual([]);
    expect(signersFromSupported("<html>")).toEqual([]);
  });

  it("keeps going when a facilitator does not answer", async () => {
    const fetchJson = async (url: string) => {
      if (url.startsWith("https://down")) throw new Error("timeout");
      return { signers: { "eip155:*": ["0x0000000000000000000000000000000000000003"] } };
    };
    const labels = await labelsFromFacilitators(fetchJson, [{ name: "Down", url: "https://down.example" }, { name: "Up", url: "https://up.example" }]);
    expect(labels).toEqual([{ address: "0x0000000000000000000000000000000000000003", role: "facilitator", name: "Up", url: "https://up.example", source: "facilitator", detail: "named in its /supported" }]);
  });
});

describe("labels from the ERC-8004 registry", () => {
  const apex: RegistryEntry = {
    id: 1,
    owner: APEX_WALLET,
    wallet: APEX_WALLET,
    cardUrl: "https://apexfaucet.xyz/agent.json",
    card: { name: "APEX Faucet", services: [{ name: "x402", endpoint: "https://apexfaucet.xyz/.well-known/x402" }, { name: "x402-discovery", endpoint: "https://apexfaucet.xyz/discovery/resources" }, { name: "web", endpoint: "https://apexfaucet.xyz" }] },
  };
  const fuci: RegistryEntry = { id: 193, owner: "0x56d2de0b00000000000000000000000000000000", wallet: null, cardUrl: null, card: { name: "Fuci", services: [{ name: "x402", endpoint: "https://www.fuci.family/.well-known/x402" }] } };
  const docs: Record<string, unknown> = {
    "https://apexfaucet.xyz/.well-known/x402": { siteName: "APEX" },
    "https://apexfaucet.xyz/discovery/resources": { items: [{ resource: "https://apexfaucet.xyz/api/a", accepts: [{ network: "eip155:8453", payTo: "0x0000000000000000000000000000000000000009" }, { network: "eip155:5042", payTo: APEX_PAYEE }] }] },
    "https://www.fuci.family/.well-known/x402": { resources: [{ url: "https://www.fuci.family/api/x402/foci/launches" }] },
  };
  const deps = (asked: string[] = []) => ({
    fetchJson: async (url: string) => {
      asked.push(url);
      if (!(url in docs)) throw new Error("404");
      return docs[url];
    },
    payToOf: async (url: string) => (url === "https://www.fuci.family/api/x402/foci/launches" ? "0x00000000000000000000000000000000000000F1" : null),
  });

  it("names an agent's owner and wallet, and the payees of the catalogue its card points at", async () => {
    const labels = await labelsFromRegistry([apex], deps());
    expect(labels).toContainEqual({ address: APEX_WALLET, role: "agent", name: "APEX Faucet", url: "https://apexfaucet.xyz/agent.json", source: "erc8004", detail: "ERC-8004 agent #1" });
    expect(labels).toContainEqual({ address: APEX_PAYEE, role: "seller", name: "APEX Faucet", url: "https://apexfaucet.xyz/discovery/resources", source: "erc8004", detail: "ERC-8004 agent #1, from the x402 catalogue its card points at" });
    // Only the payee on Arc: the same catalogue's Base payee is another chain's business.
    expect(labels.some((l) => l.address === "0x0000000000000000000000000000000000000009")).toBe(false);
    expect(labels.filter((l) => l.role === "agent")).toHaveLength(1);
  });

  it("asks a paid URL from a manifest for its payee when the manifest does not name one", async () => {
    const labels = await labelsFromRegistry([fuci], deps());
    expect(labels).toContainEqual({ address: "0x00000000000000000000000000000000000000f1", role: "seller", name: "Fuci", url: "https://www.fuci.family/.well-known/x402", source: "erc8004", detail: "ERC-8004 agent #193, from the x402 catalogue its card points at" });
  });

  it("labels an agent without a readable card by its number, and stops fetching past its budget", async () => {
    expect(await labelsFromRegistry([{ id: 7, owner: "0x0000000000000000000000000000000000000007", wallet: null, card: null, cardUrl: null }], deps())).toEqual([{ address: "0x0000000000000000000000000000000000000007", role: "agent", name: "Agent #7", url: null, source: "erc8004", detail: "ERC-8004 agent #7" }]);
    const asked: string[] = [];
    await labelsFromRegistry([apex, fuci], { ...deps(asked), maxFetches: 1 });
    expect(asked).toEqual(["https://apexfaucet.xyz/.well-known/x402"]);
  });
});

describe("reading the registry from an endpoint that may refuse us", () => {
  const OWNER = "0x33b37c6d7a98b58da3ccb3f36a4b578053d0ea74" as const;
  /** A registry with `count` agents, whose token URIs fail for the ids in `badUris`. */
  const reader = (count: number, badUris: ReadonlySet<number> = new Set()): RegistryReader => ({
    balanceOf: async () => 0n,
    agents: async (ids) => ids.map((id) => (Number(id) < count ? { owner: OWNER, wallet: null } : null)),
    tokenURI: async (id) => {
      if (badUris.has(Number(id))) throw new Error("429 Too Many Requests");
      return `https://cards.example/${id}.json`;
    },
  });
  const cards = async (url: string) => ({ name: `Card ${url.split("/").pop()}` });

  it("reads every agent and names it from its card", async () => {
    const entries = await readRegistry(reader(3), cards);
    expect(entries.map((e) => [e.id, (e.card as { name: string }).name])).toEqual([
      [0, "Card 0.json"],
      [1, "Card 1.json"],
      [2, "Card 2.json"],
    ]);
  });

  it("calls an empty registry a failed read, and so one where most cards cannot even be located", async () => {
    await expect(readRegistry(reader(0), cards)).rejects.toThrow(/no agents/);
    await expect(readRegistry(reader(4, new Set([0, 1, 2])), cards)).rejects.toThrow(/3 of 4 card addresses/);
    // One missing card among several is the agent's problem, not the endpoint's.
    expect(await readRegistry(reader(4, new Set([3])), cards)).toHaveLength(4);
  });

  it("moves on to the next endpoint, and names only hosts when every one fails", async () => {
    const byUrl: Record<string, RegistryReader> = { "https://busy.example/rpc": reader(0), "https://ok.example": reader(2) };
    const entries = await readRegistryFrom(["https://busy.example/rpc", "https://ok.example"], (u) => byUrl[u]!, cards);
    expect(entries).toHaveLength(2);
    const failing = readRegistryFrom(["https://node.example/v2/SECRETKEY", "https://busy.example/rpc"], () => reader(0), cards);
    await expect(failing).rejects.toThrow(/node\.example: the registry read found no agents; busy\.example/);
    await expect(failing).rejects.not.toThrow(/SECRETKEY/);
  });
});

describe("cards on IPFS", () => {
  const CID = "bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei";

  it("asks every public gateway for an IPFS card, whichever way the address is written", () => {
    const all = ipfsCandidates(`ipfs://${CID}`);
    expect(all[0]).toBe(`https://ipfs.filebase.io/ipfs/${CID}`);
    expect(all).toHaveLength(4);
    expect(ipfsCandidates(`ipfs://ipfs/${CID}/card.json`)[1]).toBe(`https://ipfs.io/ipfs/${CID}/card.json`);
    expect(ipfsCandidates(`https://some-gateway.example/ipfs/${CID}`)).toEqual(all);
    expect(ipfsCandidates("https://cra-agent.tech/.well-known/agent.json")).toEqual(["https://cra-agent.tech/.well-known/agent.json"]);
  });

  it("fetches a card that several agents share once per read", async () => {
    const shared: RegistryReader = {
      balanceOf: async () => 0n,
      agents: async (ids) => ids.map((id) => (Number(id) < 6 ? { owner: "0x0000000000000000000000000000000000000006", wallet: null } : null)),
      tokenURI: async () => `ipfs://${CID}`,
    };
    let fetched = 0;
    const entries = await readRegistry(shared, async () => {
      fetched++;
      return { name: "Shared card" };
    });
    expect(entries).toHaveLength(6);
    expect(entries.every((e) => (e.card as { name: string }).name === "Shared card")).toBe(true);
    expect(fetched).toBe(1);
  });
});
