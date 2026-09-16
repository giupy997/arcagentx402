import { describe, expect, it } from "vitest";
import { loadConfig, redactUrl } from "../src/config.js";

describe("loadConfig", () => {
  const base = { DATABASE_URL: "postgres://x" };
  it("defaults to testnet with the documented chain id and public endpoints", () => {
    const c = loadConfig(base);
    expect(c.network).toBe("testnet");
    expect(c.chainId).toBe(5042002);
    expect(c.rpcUrls[0]).toBe("https://rpc.testnet.arc.io");
  });
  it("mainnet requires explicit endpoints (none are published yet)", () => {
    expect(() => loadConfig({ ...base, ARC_NETWORK: "mainnet" })).toThrow(/No RPC endpoints/);
    const c = loadConfig({ ...base, ARC_NETWORK: "mainnet", ARC_RPC_URLS: "https://a,https://b" });
    expect(c.chainId).toBe(5042);
    expect(c.rpcUrls).toEqual(["https://a", "https://b"]);
  });
  it("appends keyed providers and honours overrides", () => {
    const c = loadConfig({ ...base, ALCHEMY_ARC_URL: "https://arc-testnet.g.alchemy.com/v2/abcdefghijklmnopqrstuvwxyz", ARC_CHAIN_ID: "7", COLLECTOR_ENRICH_REVERTS: "0" });
    expect(c.rpcUrls.at(-1)).toContain("alchemy");
    expect(c.chainId).toBe(7);
    expect(c.enrichReverts).toBe(false);
  });
  it("rejects bad values", () => {
    expect(() => loadConfig({})).toThrow();
    expect(() => loadConfig({ ...base, COLLECTOR_BATCH_BLOCKS: "500" })).toThrow();
    expect(() => loadConfig({ ...base, ARC_RPC_URLS: "ftp://x" })).toThrow();
  });
});

describe("redactUrl", () => {
  it("masks long path segments (API keys)", () => {
    expect(redactUrl("https://arc-testnet.g.alchemy.com/v2/abcdefghijklmnopqrstuvwxyz")).toBe("https://arc-testnet.g.alchemy.com/v2/abcd…");
    expect(redactUrl("https://rpc.testnet.arc.io")).toBe("https://rpc.testnet.arc.io/");
  });
});

describe("backfill flag", () => {
  it("is off only when explicitly disabled", () => {
    expect(loadConfig({ DATABASE_URL: "postgres://x" }).backfillHistory).toBe(true);
    expect(loadConfig({ DATABASE_URL: "postgres://x", COLLECTOR_BACKFILL_HISTORY: "0" }).backfillHistory).toBe(false);
  });
});
