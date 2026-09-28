import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryLedger } from "@cra-agent/ledger";
import { createSigner } from "@cra-agent/identity";
import { parsePolicyString } from "@cra-agent/policy";
import { createRail, PolicyRejected } from "../src/index.js";

const SELLER = "0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74";
const FACILITATOR = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const URL_ = "https://seller.example/v1/upto/think?task=hello";
const RPC = "http://rpc.test";
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

// The chain, as far as the buyer asks it: Permit2 may not move this wallet's USDC yet, and its permit nonce is 0.
beforeAll(() => {
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).startsWith(RPC)) return real(input, init);
    const { id } = JSON.parse(String(init!.body)) as { id: number };
    return Response.json({ jsonrpc: "2.0", id, result: `0x${"0".repeat(64)}` });
  });
});
afterAll(() => void vi.unstubAllGlobals());

/** A seller billing by use: a ceiling of `ceiling` base units, of which it takes `taken`. */
function seller(ceiling: string, taken: string | null) {
  const paid: Array<{ scheme: string; permitted: string; permit: unknown }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
    const signature = headers.get("PAYMENT-SIGNATURE");
    if (signature) {
      const p = JSON.parse(Buffer.from(signature, "base64").toString("utf8"));
      paid.push({ scheme: p.accepted.scheme, permitted: p.payload.permit2Authorization.permitted.amount, permit: p.extensions?.eip2612GasSponsoring?.info ?? null });
      const settled = { success: true, transaction: `0x${"cd".repeat(32)}`, network: "eip155:5042", payer: p.payload.permit2Authorization.from, ...(taken === null ? {} : { amount: taken }) };
      return new Response(JSON.stringify({ answer: 42 }), { status: 200, headers: { "content-type": "application/json", "PAYMENT-RESPONSE": b64(settled) } });
    }
    const required = {
      x402Version: 2,
      resource: { url: URL_, description: "an agent's work, billed by what it spent", mimeType: "application/json" },
      accepts: [{ scheme: "upto", network: "eip155:5042", amount: ceiling, asset: "0x3600000000000000000000000000000000000000", payTo: SELLER, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2", assetTransferMethod: "permit2", facilitatorAddress: FACILITATOR } }],
      extensions: { eip2612GasSponsoring: { info: { description: "gasless Permit2 approval", version: "1" }, schema: {} } },
    };
    return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64(required), "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, paid };
}

function rail(fetchImpl: typeof fetch, policy = "daily=1,per_seller=1,per_payment=0.15") {
  const ledger = new MemoryLedger();
  const signer = createSigner({ scheme: "secp256k1", privateKey: `0x${"42".repeat(32)}` });
  return { ledger, rail: createRail({ network: "arc", signer, policy: parsePolicyString(policy), ledger, identity: null, agentId: "test", fetch: fetchImpl, rpcUrl: RPC }) };
}

describe("paying a seller that bills by use (x402 upto)", () => {
  it("signs for the ceiling with a permit instead of an approval, and keeps only what was taken as spent", async () => {
    const s = seller("100000", "21300");
    const { rail: r, ledger } = rail(s.fetchImpl);
    const res = await r.fetch(URL_);
    expect(res.response.status).toBe(200);
    expect(s.paid).toEqual([{ scheme: "upto", permitted: "100000", permit: expect.objectContaining({ spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3", amount: "100000", nonce: "0" }) }]);
    expect(res.receipt).toMatchObject({ status: "settled", amountUsdc: "0.0213" });
    const [row] = await ledger.recent("test", 1);
    expect(row).toMatchObject({ scheme: "upto", status: "settled", amount: 21_300n });
    expect(row!.meta).toMatchObject({ upto: { ceilingUsdc: "0.1" } });
    expect(await ledger.spentSince("test", new Date(0))).toBe(21_300n);
  });

  it("counts the whole ceiling when the settlement does not say what it took", async () => {
    const { rail: r, ledger } = rail(seller("100000", null).fetchImpl);
    await r.fetch(URL_);
    expect((await ledger.recent("test", 1))[0]).toMatchObject({ status: "settled", amount: 100_000n });
  });

  it("holds the ceiling to the policy, since all of it could be taken", async () => {
    const s = seller("100000", "21300");
    const err = await rail(s.fetchImpl, "daily=1,per_seller=1,per_payment=0.05").rail.fetch(URL_).catch((e) => e);
    expect(err).toBeInstanceOf(PolicyRejected);
    expect((err as PolicyRejected).decision).toMatchObject({ rule: "per_payment" });
    expect(s.paid).toHaveLength(0);
  });
});
