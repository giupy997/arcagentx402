import { describe, expect, it } from "vitest";
import { usdc6 } from "@cra-agent/accounting";
import { defineChain } from "viem";
import { createFacilitator } from "../src/index.js";

const arc = defineChain({ id: 5042, name: "Arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: ["http://127.0.0.1:1"] } } });
const KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";

describe("what the facilitator says it settles", () => {
  it("lists exact and upto on Arc, and gives upto the address a buyer's authorization must name", async () => {
    const { app, address } = createFacilitator({ chain: arc, network: "eip155:5042", rpcUrl: "http://127.0.0.1:1", privateKey: KEY, rules: { payTo: new Set(), assets: new Map(), minAmount: usdc6(1n), maxAmount: usdc6(1_000_000n) } });
    const supported = (await (await app.request("/supported")).json()) as { kinds: Array<{ scheme: string; network: string; extra?: Record<string, unknown> }> };
    expect(supported.kinds.map((k) => `${k.scheme} ${k.network}`).sort()).toEqual(["exact eip155:5042", "upto eip155:5042"]);
    expect(supported.kinds.find((k) => k.scheme === "upto")?.extra?.facilitatorAddress).toBe(address);
  });
});
